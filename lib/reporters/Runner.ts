import charm = require('charm');
import { format } from 'util';
import Collector = require('istanbul/lib/collector');
import SummaryReporter = require('istanbul/lib/report/text-summary');
import DetailedReporter = require('istanbul/lib/report/text');
// TODO: Pass in to reporter as runType
import { mode } from '../../main';
import { getErrorMessage } from '../util';
import { Reporter, ReporterKwArgs } from '../ReporterManager';
import { Coverage } from 'istanbul/lib/instrumenter';
import Proxy from '../Proxy';
import Test from '../Test';
import Suite from '../Suite';
import Tunnel = require('digdug/Tunnel');

const LIGHT_RED = '\x1b[91m';
const LIGHT_GREEN = '\x1b[92m';
const LIGHT_YELLOW = '\x1b[93m';
const LIGHT_MAGENTA = '\x1b[95m';

export default class Runner implements Reporter {
	sessions: { [sessionId: string]: { suite: Suite; coverage: Collector; }; };
	hasErrors: boolean;
	proxyOnly: boolean;
	reporter: SummaryReporter;
	detailedReporter: DetailedReporter;
	charm: charm.Charm;

	constructor(config: ReporterKwArgs = {}) {
		this.sessions = {};
		this.hasErrors = false;
		this.proxyOnly = Boolean(config.internConfig.proxyOnly);
		this.reporter = new SummaryReporter({
			watermarks: config.watermarks
		});
		this.detailedReporter = new DetailedReporter({
			watermarks: config.watermarks
		});

		this.charm = charm();
		this.charm.pipe(config.output);
		this.charm.display('reset');
	}

	coverage(sessionId: string, coverage: Coverage) {
		// coverage will be called for the runner host, which has no session ID -- ignore that
		if (mode === 'client' || sessionId) {
			const session = this.sessions[sessionId || ''];
			session.coverage = session.coverage || new Collector();
			session.coverage.add(coverage);
		}
	}

	deprecated(name: string, replacement: string, extra: string) {
		this.charm
			.write(LIGHT_YELLOW)
			.write('⚠︎ ' + name + ' is deprecated. ');

		if (replacement) {
			this.charm.write('Use ' + replacement + ' instead.');
		}
		else {
			this.charm.write('Please open a ticket at https://github.com/theintern/intern/issues if you still ' +
				'require access to this function.');
		}

		if (extra) {
			this.charm.write(' ' + extra);
		}

		this.charm.write('\n').display('reset');
	}

	fatalError(error: Error) {
		this.charm
			.background('red')
			.write('(ノಠ益ಠ)ノ彡┻━┻\n')
			.write(getErrorMessage(error))
			.display('reset')
			.write('\n');

		this.hasErrors = true;
	}

	proxyStart(proxy: Proxy) {
		this.charm.write('Listening on 0.0.0.0:' + proxy.config.port + '\n');
	}

	reporterError(reporter: Reporter, error: Error) {
		this.charm
			.background('red')
			.write('Reporter error!\n')
			.write(getErrorMessage(error))
			.display('reset')
			.write('\n');
	}

	runEnd() {
		const collector = new Collector();
		let numEnvironments = 0;
		let numTests = 0;
		let numFailedTests = 0;
		let numSkippedTests = 0;

		for (const sessionId in this.sessions) {
			const session = this.sessions[sessionId];
			session.coverage && collector.add(session.coverage.getFinalCoverage());
			++numEnvironments;
			numTests += session.suite.numTests;
			numFailedTests += session.suite.numFailedTests;
			numSkippedTests += session.suite.numSkippedTests;
		}

		// add a newline between test results and coverage results for prettier output
		this.charm.write('\n');

		if (collector.files().length > 0) {
			this.detailedReporter.writeReport(collector, false);
		}

		let message = 'TOTAL: tested %d platforms, %d/%d tests failed';

		if (numSkippedTests) {
			message += ' (' + numSkippedTests + ' skipped)';
		}

		if (this.hasErrors && !numFailedTests) {
			message += '; fatal error occurred';
		}

		this.charm
			.display('bright')
			.background(numFailedTests > 0 || this.hasErrors ? 'red' : 'green')
			.write(format(message, numEnvironments, numFailedTests, numTests))
			.display('reset')
			.write('\n');
	}

	suiteEnd(suite: Suite) {
		if (!suite.hasParent) {
			// runEnd will report all of this information, so do not repeat it
			if (mode === 'client') {
				return;
			}

			// Runner mode test with no sessionId was some failed test, not a bug
			if (!suite.sessionId) {
				return;
			}

			if (!this.sessions[suite.sessionId]) {
				if (!this.proxyOnly) {
					this.charm
						.write(LIGHT_YELLOW)
						.write('BUG: suiteEnd was received for invalid session ' + suite.sessionId)
						.display('reset')
						.write('\n');
				}

				return;
			}

			const session = this.sessions[suite.sessionId];

			if (session.coverage) {
				this.reporter.writeReport(session.coverage, false);
			}
			else {
				this.charm
					.write('No unit test coverage for ' + suite.name)
					.display('reset')
					.write('\n');
			}

			const name = suite.name;
			const hasError = (function hasError(suite: Suite | Test): boolean {
				return (<Suite> suite).tests ? (Boolean(suite.error) || (<Suite> suite).tests.some(hasError)) : false;
			})(suite);
			const numFailedTests = suite.numFailedTests;
			const numTests = suite.numTests;
			const numSkippedTests = suite.numSkippedTests;

			let summary = format('%s: %d/%d tests failed', name, numFailedTests, numTests);
			if (numSkippedTests) {
				summary += ' (' + numSkippedTests + ' skipped)';
			}

			if (hasError) {
				summary += '; fatal error occurred';
			}

			this.charm
				.write(numFailedTests || hasError ? LIGHT_RED : LIGHT_GREEN)
				.write(summary)
				.display('reset')
				.write('\n\n');
		}
	}

	suiteError(suite: Suite) {
		const error = suite.error;

		this.charm
			.background('red')
			.write('Suite ' + suite.id + ' FAILED\n')
			.write(getErrorMessage(error))
			.display('reset')
			.write('\n');

		this.hasErrors = true;
	}

	suiteStart(suite: Suite) {
		if (!suite.hasParent) {
			this.sessions[suite.sessionId || ''] = { suite: suite, coverage: null };
			if (suite.sessionId) {
				this.charm.write('‣ Created session ' + suite.name + ' (' + suite.sessionId + ')\n');
			}
		}
	}

	testFail(test: Test) {
		this.charm
			.write(LIGHT_RED)
			.write('× ' + test.id)
			.foreground('white')
			.write(' (' + (test.timeElapsed / 1000) + 's)')
			.write('\n')
			.foreground('red')
			.write(getErrorMessage(test.error))
			.display('reset')
			.write('\n');
	}

	testPass(test: Test) {
		this.charm
			.write(LIGHT_GREEN)
			.write('✓ ' + test.id)
			.foreground('white')
			.write(' (' + (test.timeElapsed / 1000) + 's)')
			.display('reset')
			.write('\n');
	}

	testSkip(test: Test) {
		this.charm
			.write(LIGHT_MAGENTA)
			.write('~ ' + test.id)
			.foreground('white')
			.write(' (' + (test.skipped || 'skipped') + ')')
			.display('reset')
			.write('\n');
	}

	tunnelDownloadProgress(tunnel: Tunnel, progress: Tunnel.Progress) {
		this.charm.write('Tunnel download: ' + (progress.loaded / progress.total * 100).toFixed(3) + '%\r');
	}

	tunnelStart() {
		this.charm.write('Tunnel started\n');
	}

	tunnelStatus(tunnel: Tunnel, status: string) {
		this.charm.write(status + '\x1b[K\r');
	}
}