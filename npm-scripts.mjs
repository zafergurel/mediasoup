import * as process from 'node:process';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import fetch from 'node-fetch';
import tar from 'tar';

const PKG = JSON.parse(fs.readFileSync('./package.json').toString());
const IS_WINDOWS = os.platform() === 'win32';
const MAYOR_VERSION = PKG.version.split('.')[0];
const PYTHON = getPython();
const PIP_INVOKE_DIR = path.resolve('worker/pip_invoke');
const FLATBUFFERS_VERSION = '23.3.3';
const WORKER_RELEASE_DIR = 'worker/out/Release';
const WORKER_RELEASE_BIN = IS_WINDOWS ? 'mediasoup-worker.exe' : 'mediasoup-worker';
const WORKER_RELEASE_BIN_PATH = `${WORKER_RELEASE_DIR}/${WORKER_RELEASE_BIN}`;
const WORKER_PREBUILD_DIR = 'worker/prebuild';
const WORKER_PREBUILD_TAR = getWorkerPrebuildTarName();
const WORKER_PREBUILD_TAR_PATH = `${WORKER_PREBUILD_DIR}/${WORKER_PREBUILD_TAR}`;
const GH_OWNER = 'versatica';
const GH_REPO = 'mediasoup';

const task = process.argv[2];
const args = process.argv.slice(3).join(' ');

// PYTHONPATH env must be updated now so all invoke calls below will find the
// pip invoke module.
if (process.env.PYTHONPATH)
{
	if (IS_WINDOWS)
	{
		process.env.PYTHONPATH = `${PIP_INVOKE_DIR};${process.env.PYTHONPATH}`;
	}
	else
	{
		process.env.PYTHONPATH = `${PIP_INVOKE_DIR}:${process.env.PYTHONPATH}`;
	}
}
else
{
	process.env.PYTHONPATH = PIP_INVOKE_DIR;
}

run();

async function run()
{
	logInfo(args ? `[args:"${args}"]` : '');

	switch (task)
	{
		// As per NPM documentation (https://docs.npmjs.com/cli/v9/using-npm/scripts)
		// `prepare` script:
		//
		// - Runs BEFORE the package is packed, i.e. during `npm publish` and `npm pack`.
		// - Runs on local `npm install` without any arguments.
		// - NOTE: If a package being installed through git contains a `prepare` script,
		//   its dependencies and devDependencies will be installed, and the `prepare`
		//   script will be run, before the package is packaged and installed.
		//
		// So here we generate flatbuffers definitions for TypeScript and compile
		// TypeScript to JavaScript.
		case 'prepare':
		{
			flatcNode();
			buildTypescript({ force: false });

			break;
		}

		case 'postinstall':
		{
			// If the user/app provides us with a custom mediasoup-worker binary then
			// don't do anything.
			if (process.env.MEDIASOUP_WORKER_BIN)
			{
				logInfo('MEDIASOUP_WORKER_BIN environment variable given, skipping');

				break;
			}
			// If MEDIASOUP_LOCAL_DEV is given, or if MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD
			// env is given, or if mediasoup package is being installed via git+ssh
			// (instead of via npm), and if MEDIASOUP_FORCE_PREBUILT_WORKER_DOWNLOAD env is
			// not set, then skip mediasoup-worker prebuilt download.
			else if (
				(
					process.env.MEDIASOUP_LOCAL_DEV ||
					process.env.MEDIASOUP_SKIP_WORKER_PREBUILT_DOWNLOAD ||
					process.env.npm_package_resolved?.startsWith('git+ssh://')
				) &&
				!process.env.MEDIASOUP_FORCE_WORKER_PREBUILT_DOWNLOAD
			)
			{
				logInfo('skipping mediasoup-worker prebuilt download, building it locally');

				buildWorker();

				if (!process.env.MEDIASOUP_LOCAL_DEV)
				{
					cleanWorkerArtifacts();
				}
			}
			// Attempt to download a prebuilt binary. Fallback to building locally.
			else if (!(await downloadPrebuiltWorker()))
			{
				logInfo(`couldn't fetch any mediasoup-worker prebuilt binary, building it locally`);

				buildWorker();

				if (!process.env.MEDIASOUP_LOCAL_DEV)
				{
					cleanWorkerArtifacts();
				}
			}

			break;
		}

		case 'typescript:build':
		{
			installNodeDeps();
			buildTypescript({ force: true });

			break;
		}

		case 'typescript:watch':
		{
			deleteNodeLib();
			executeCmd(`tsc --project node --watch ${args}`);

			break;
		}

		case 'worker:build':
		{
			buildWorker();

			break;
		}

		case 'worker:prebuild':
		{
			await prebuildWorker();

			break;
		}

		case 'lint:node':
		{
			lintNode();

			break;
		}

		case 'lint:worker':
		{
			lintWorker();

			break;
		}

		case 'format:worker':
		{
			installInvoke();

			executeCmd(`"${PYTHON}" -m invoke -r worker format`);

			break;
		}

		case 'flatc:node':
		{
			flatcNode();

			break;
		}

		case 'flatc:worker':
		{
			flatcWorker();

			break;
		}

		case 'test:node':
		{
			buildTypescript({ force: false });
			testNode();

			break;
		}

		case 'test:worker':
		{
			testWorker();

			break;
		}

		case 'coverage:node':
		{
			buildTypescript({ force: false });
			executeCmd(`jest --coverage ${args}`);
			executeCmd('open-cli coverage/lcov-report/index.html');

			break;
		}

		case 'release:check':
		{
			checkRelease();

			break;
		}

		case 'release':
		{
			let octokit;
			let versionChanges;

			try
			{
				octokit = await getOctokit();
				versionChanges = await getVersionChanges();
			}
			catch (error)
			{
				logError(error.message);

				exitWithError();
			}

			checkRelease();
			executeCmd(`git commit -am '${PKG.version}'`);
			executeCmd(`git tag -a ${PKG.version} -m '${PKG.version}'`);
			executeCmd(`git push origin v${MAYOR_VERSION}`);
			executeCmd(`git push origin '${PKG.version}'`);

			logInfo('creating release in GitHub');

			await octokit.repos.createRelease(
				{
					owner    : GH_OWNER,
					repo     : GH_REPO,
					name     : PKG.version,
					body     : versionChanges,
					// eslint-disable-next-line camelcase
					tag_name : PKG.version,
					draft    : false
				});

			// GitHub mediasoup-worker-prebuild CI action doesn't create mediasoup-worker
			// prebuilt binary for macOS ARM. If this is a macOS ARM machine, do it here
			// and upload it to the release.
			if (os.platform() === 'darwin' && os.arch() === 'arm64')
			{
				await prebuildWorker();
				await uploadMacArmPrebuiltWorker();
			}

			executeCmd('npm publish');

			break;
		}

		case 'release:upload-mac-arm-prebuilt-worker':
		{
			checkRelease();
			await prebuildWorker();
			await uploadMacArmPrebuiltWorker();

			break;
		}

		default:
		{
			logError('unknown task');

			exitWithError();
		}
	}
}

function getPython()
{
	let python = process.env.PYTHON;

	if (!python)
	{
		try
		{
			execSync('python3 --version', { stdio: [ 'ignore', 'ignore', 'ignore' ] });
			python = 'python3';
		}
		catch (error)
		{
			python = 'python';
		}
	}

	return python;
}

function getWorkerPrebuildTarName()
{
	let name = `mediasoup-worker-${PKG.version}-${os.platform()}-${os.arch()}`;

	// In Linux we want to know about kernel version since kernel >= 6 supports
	// io-uring.
	if (os.platform() === 'linux')
	{
		const kernelMajorVersion = Number(os.release().split('.')[0]);

		name += `-kernel${kernelMajorVersion}`;
	}

	return `${name}.tgz`;
}

function installInvoke()
{
	if (fs.existsSync(PIP_INVOKE_DIR))
	{
		return;
	}

	logInfo('installInvoke()');

	// Install pip invoke into custom location, so we don't depend on system-wide
	// installation.
	executeCmd(
		`"${PYTHON}" -m pip install --upgrade --no-user --target="${PIP_INVOKE_DIR}" invoke`,
		/* exitOnError */ true
	);
}

function deleteNodeLib()
{
	if (!fs.existsSync('node/lib'))
	{
		return;
	}

	logInfo('deleteNodeLib()');

	fs.rmSync('node/lib', { recursive: true, force: true });
}

function buildTypescript({ force = false } = { force: false })
{
	if (!force && fs.existsSync('node/lib'))
	{
		return;
	}

	logInfo('buildTypescript()');

	deleteNodeLib();
	executeCmd('tsc --project node');
}

function buildWorker()
{
	logInfo('buildWorker()');

	installInvoke();

	executeCmd(`"${PYTHON}" -m invoke -r worker mediasoup-worker`);
}

function cleanWorkerArtifacts()
{
	logInfo('cleanWorkerArtifacts()');

	installInvoke();

	// Clean build artifacts except `mediasoup-worker`.
	executeCmd(`"${PYTHON}" -m invoke -r worker clean-build`);
	// Clean downloaded dependencies.
	executeCmd(`"${PYTHON}" -m invoke -r worker clean-subprojects`);
	// Clean PIP/Meson/Ninja.
	executeCmd(`"${PYTHON}" -m invoke -r worker clean-pip`);
}

function lintNode()
{
	logInfo('lintNode()');

	executeCmd('eslint -c node/.eslintrc.js --ignore-path node/.eslintignore --max-warnings 0 node/src node/.eslintrc.js npm-scripts.mjs worker/scripts/clang-format.mjs');
}

function lintWorker()
{
	logInfo('lintWorker()');

	installInvoke();

	executeCmd(`"${PYTHON}" -m invoke -r worker lint`);
}

function flatcNode()
{
	logInfo('flatcNode()');

	installInvoke();

	// Build flatc if needed.
	executeCmd(`"${PYTHON}" -m invoke -r worker flatc`);

	const buildType = process.env.MEDIASOUP_BUILDTYPE || 'Release';
	const extension = IS_WINDOWS ? '.exe' : '';
	const flatc = path.resolve(path.join(
		'worker', 'out', buildType, 'build', 'subprojects', `flatbuffers-${FLATBUFFERS_VERSION}`, `flatc${extension}`));
	const out = path.resolve(path.join('node', 'src'));

	for (const dirent of fs.readdirSync(path.join('worker', 'fbs'), { withFileTypes: true }))
	{
		if (!dirent.isFile() || path.parse(dirent.name).ext !== '.fbs')
		{
			continue;
		}

		const filePath = path.resolve(path.join('worker', 'fbs', dirent.name));

		executeCmd(`"${flatc}" --ts --ts-no-import-ext --gen-object-api -o "${out}" "${filePath}"`);
	}
}

function flatcWorker()
{
	logInfo('flatcWorker()');

	installInvoke();

	executeCmd(`"${PYTHON}" -m invoke -r worker flatc`);
}

function testNode()
{
	logInfo('testNode()');

	executeCmd(`jest ${args}`);
}

function testWorker()
{
	logInfo('testWorker()');

	installInvoke();

	executeCmd(`"${PYTHON}" -m invoke -r worker test`);
}

function installNodeDeps()
{
	logInfo('installNodeDeps()');

	// Install/update Node deps.
	executeCmd('npm ci --ignore-scripts');
	// Update package-lock.json.
	executeCmd('npm install --package-lock-only --ignore-scripts');
}

function checkRelease()
{
	logInfo('checkRelease()');

	installNodeDeps();
	flatcNode();
	buildTypescript({ force: true });
	buildWorker();
	lintNode();
	lintWorker();
	testNode();
	testWorker();
}

function ensureDir(dir)
{
	logInfo(`ensureDir() [dir:${dir}]`);

	if (!fs.existsSync(dir))
	{
		fs.mkdirSync(dir, { recursive: true });
	}
}

async function prebuildWorker()
{
	logInfo('prebuildWorker()');

	ensureDir(WORKER_PREBUILD_DIR);

	return new Promise((resolve, reject) =>
	{
		// Generate a gzip file which just contains mediasoup-worker binary without
		// any folder.
		tar.create(
			{
				cwd  : WORKER_RELEASE_DIR,
				gzip : true
			},
			[ WORKER_RELEASE_BIN ])
			.pipe(fs.createWriteStream(WORKER_PREBUILD_TAR_PATH))
			.on('finish', resolve)
			.on('error', reject);
	});
}

// Returns a Promise resolving to true if a mediasoup-worker prebuilt binary
// was downloaded and uncompressed, false otherwise.
async function downloadPrebuiltWorker()
{
	const releaseBase =
		process.env.MEDIASOUP_WORKER_PREBUILT_DOWNLOAD_BASE_URL ||
		`${PKG.repository.url.replace(/\.git$/, '')}/releases/download`;

	const tarUrl = `${releaseBase}/${PKG.version}/${WORKER_PREBUILD_TAR}`;

	logInfo(`downloadPrebuiltWorker() [tarUrl:${tarUrl}]`);

	ensureDir(WORKER_PREBUILD_DIR);

	let res;

	try
	{
		res = await fetch(tarUrl);

		if (res.status === 404)
		{
			logInfo(
				'downloadPrebuiltWorker() | no available mediasoup-worker prebuilt binary for current architecture'
			);

			return false;
		}
		else if (!res.ok)
		{
			logError(
				`downloadPrebuiltWorker() | failed to download mediasoup-worker prebuilt binary: ${res.status} ${res.statusText}`
			);

			return false;
		}
	}
	catch (error)
	{
		logError(
			`downloadPrebuiltWorker() | failed to download mediasoup-worker prebuilt binary: ${error}`
		);

		return false;
	}

	ensureDir(WORKER_RELEASE_DIR);

	return new Promise((resolve) =>
	{
		// Extract mediasoup-worker in the official mediasoup-worker path.
		res.body
			.pipe(tar.extract(
				{
					newer : false,
					cwd   : WORKER_RELEASE_DIR
				}))
			.on('finish', () =>
			{
				logInfo('downloadPrebuiltWorker() | got mediasoup-worker prebuilt binary');

				try
				{
					// Give execution permission to the binary.
					fs.chmodSync(WORKER_RELEASE_BIN_PATH, 0o775);
				}
				catch (error)
				{
					logWarn(`downloadPrebuiltWorker() | failed to give execution permissions to the mediasoup-worker prebuilt binary: ${error}`);
				}

				// Let's confirm that the fetched mediasoup-worker prebuit binary does
				// run in current host. This is to prevent weird issues related to
				// different versions of libc in the system and so on.
				// So run mediasoup-worker without the required MEDIASOUP_VERSION env and
				// expect exit code 41 (see main.cpp).

				logInfo(
					'downloadPrebuiltWorker() | checking fetched mediasoup-worker prebuilt binary in current host'
				);

				try
				{
					const resolvedBinPath = path.resolve(WORKER_RELEASE_BIN_PATH);

					// This will always fail on purpose, but if status code is 41 then
					// it's good.
					execSync(
						`"${resolvedBinPath}"`,
						{
							stdio : [ 'ignore', 'ignore', 'ignore' ],
							// Ensure no env is passed to avoid accidents.
							env   : {}
						}
					);
				}
				catch (error)
				{
					if (error.status === 41)
					{
						logInfo(
							'downloadPrebuiltWorker() | fetched mediasoup-worker prebuilt binary is valid for current host'
						);

						resolve(true);
					}
					else
					{
						logError(
							`downloadPrebuiltWorker() | fetched mediasoup-worker prebuilt binary fails to run in this host [status:${error.status}]`
						);

						try
						{
							fs.unlinkSync(WORKER_RELEASE_BIN_PATH);
						}
						catch (error2)
						{}

						resolve(false);
					}
				}
			})
			.on('error', (error) =>
			{
				logError(
					`downloadPrebuiltWorker() | failed to uncompress downloaded mediasoup-worker prebuilt binary: ${error}`
				);

				resolve(false);
			});
	});
}

async function uploadMacArmPrebuiltWorker()
{
	if (os.platform() !== 'darwin' || os.arch() !== 'arm64')
	{
		logWarn('uploadMacArmPrebuiltWorker() | invalid platform or architecture');

		return;
	}

	const octokit = await getOctokit();

	logInfo('uploadMacArmPrebuiltWorker() | getting release info');

	const release = await octokit.rest.repos.getReleaseByTag(
		{
			owner : GH_OWNER,
			repo  : GH_REPO,
			tag   : PKG.version
		});

	logInfo('uploadMacArmPrebuiltWorker() | uploading release asset');

	await octokit.rest.repos.uploadReleaseAsset(
		{
			owner      : GH_OWNER,
			repo       : GH_REPO,
			// eslint-disable-next-line camelcase
			release_id : release.data.id,
			name       : WORKER_PREBUILD_TAR,
			data       : fs.readFileSync(WORKER_PREBUILD_TAR_PATH)
		});
}

async function getOctokit()
{
	if (!process.env.GITHUB_TOKEN)
	{
		throw new Error('missing GITHUB_TOKEN environment variable');
	}

	// NOTE: Load dep on demand since it's a devDependency.
	const { Octokit } = await import('@octokit/rest');

	const octokit = new Octokit(
		{
			auth : process.env.GITHUB_TOKEN
		});

	return octokit;
}

async function getVersionChanges()
{
	logInfo('getVersionChanges()');

	// NOTE: Load dep on demand since it's a devDependency.
	const marked = await import('marked');

	const changelog = fs.readFileSync('./CHANGELOG.md').toString();
	const entries = marked.lexer(changelog);

	for (let idx = 0; idx < entries.length; ++idx)
	{
		const entry = entries[idx];

		if (entry.type === 'heading' && entry.text === PKG.version)
		{
			const changes = entries[idx + 1].raw;

			return changes;
		}
	}

	// This should not happen (unless author forgot to update CHANGELOG).
	throw new Error(`no entry found in CHANGELOG.md for version '${PKG.version}'`);
}

function executeCmd(command, exitOnError = true)
{
	logInfo(`executeCmd(): ${command}`);

	try
	{
		execSync(command, { stdio: [ 'ignore', process.stdout, process.stderr ] });
	}
	catch (error)
	{
		if (exitOnError)
		{
			logError(`executeCmd() failed, exiting: ${error}`);

			exitWithError();
		}
		else
		{
			logInfo(`executeCmd() failed, ignoring: ${error}`);
		}
	}
}

function logInfo(message)
{
	// eslint-disable-next-line no-console
	console.log(`npm-scripts.mjs \x1b[36m[INFO] [${task}]\x1b\[0m`, message);
}

function logWarn(message)
{
	// eslint-disable-next-line no-console
	console.warn(`npm-scripts.mjs \x1b[33m[WARN] [${task}]\x1b\[0m`, message);
}

function logError(message)
{
	// eslint-disable-next-line no-console
	console.error(`npm-scripts.mjs \x1b[31m[ERROR] [${task}]\x1b\[0m`, message);
}

function exitWithError()
{
	process.exit(1);
}
