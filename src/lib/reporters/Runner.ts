import * as charm from 'charm';
import * as nodeUtil from 'util';
import Test from '../Test';
import Suite from '../Suite';
import { createEventHandler } from './Reporter';
import Coverage, { CoverageProperties } from './Coverage';
import { createCoverageMap, CoverageMap } from 'istanbul-lib-coverage';
import { Writable } from 'stream';
import Server from '../Server';
import { CoverageMessage, DeprecationMessage } from '../executors/Executor';
import Node, { Events, TunnelMessage } from '../executors/Node';

export type Charm = charm.CharmInstance;

const eventHandler = createEventHandler<Events>();

export default class Runner extends Coverage {
	sessions: {
		[sessionId: string]: {
			coverage?: CoverageMap;
			suite: Suite;
			[key: string]: any;
		}
	};

	hasErrors: boolean;

	hidePassed: boolean;

	hideSkipped: boolean;

	serveOnly: boolean;

	private _deprecationMessages: { [message: string]: boolean };

	protected charm: Charm;

	constructor(executor: Node, config: Partial<CoverageProperties> = {}) {
		super(executor, config);

		this.sessions = {};
		this.hasErrors = false;
		this.serveOnly = executor.config.serveOnly;

		this.charm = charm();
		this.charm.pipe(<Writable>this.output);
		this.charm.display('reset');

		this._deprecationMessages = {};
	}

	@eventHandler()
	coverage(message: CoverageMessage) {
		const session = this.sessions[message.sessionId || ''];
		session.coverage = session.coverage || createCoverageMap();
		session.coverage.merge(message.coverage);
	}

	@eventHandler()
	deprecated(message: DeprecationMessage) {
		// Keep track of deprecation messages we've seen before
		const key = `${message.original}|${message.replacement}|${message.message}`;
		if (this._deprecationMessages[key]) {
			return;
		}
		this._deprecationMessages[key] = true;

		this.charm
			.foreground('yellow')
			.write('⚠︎ ' + message.original + ' is deprecated. ');

		if (message.replacement) {
			this.charm.write('Use ' + message.replacement + ' instead.');
		}
		else {
			this.charm.write('Please open a ticket at https://github.com/theintern/intern/issues if you still ' +
				'require access to this function.');
		}

		if (message.message) {
			this.charm.write(' ' + message.message);
		}

		this.charm.write('\n');
		this.charm.display('reset');
	}

	@eventHandler()
	error(error: Error) {
		this.charm.foreground('red');
		this.charm.write('(ノಠ益ಠ)ノ彡┻━┻\n');
		this.charm.write(this.formatError(error));
		this.charm.display('reset');
		this.charm.write('\n\n');

		this.hasErrors = true;
	}

	@eventHandler()
	log(message: string) {
		message.split('\n').forEach(line => {
			console.log(`DEBUG: ${line}`);
		});
	}

	@eventHandler()
	runEnd() {
		let map = createCoverageMap();
		let numTests = 0;
		let numFailedTests = 0;
		let numSkippedTests = 0;

		const sessionIds = Object.keys(this.sessions);
		const numEnvironments = sessionIds.length;

		if (sessionIds.length > 1) {
			sessionIds.forEach(sessionId => {
				const session = this.sessions[sessionId];
				if (session.coverage) {
					map.merge(session.coverage);
				}
				numTests += session.suite.numTests;
				numFailedTests += session.suite.numFailedTests;
				numSkippedTests += session.suite.numSkippedTests;
			});

			const charm = this.charm;

			if (map.files().length > 0) {
				charm.write('\n');
				charm.display('bright');
				charm.write('Total coverage\n');
				charm.display('reset');
				this.createCoverageReport(this.reportType, map);
			}

			let message = 'TOTAL: tested %d platforms, %d/%d tests failed';

			if (numSkippedTests) {
				message += ' (' + numSkippedTests + ' skipped)';
			}

			if (this.hasErrors && !numFailedTests) {
				message += '; fatal error occurred';
			}

			charm.display('bright');
			charm.foreground(numFailedTests > 0 || this.hasErrors ? 'red' : 'green');
			charm.write(nodeUtil.format(message, numEnvironments, numFailedTests, numTests));
			charm.display('reset');
			charm.write('\n');
		}
	}

	@eventHandler()
	serverStart(server: Server) {
		let message = `Listening on localhost:${server.port}`;
		if (server.socketPort) {
			message += ` (ws ${server.socketPort})`;
		}
		this.charm.write(`${message}\n`);
	}

	@eventHandler()
	suiteEnd(suite: Suite) {
		if (suite.error) {
			const error = suite.error;
			const charm = this.charm;

			charm.foreground('red');
			charm.write('Suite ' + suite.id + ' FAILED\n');
			charm.write(this.formatError(error));
			charm.display('reset');
			charm.write('\n');

			this.hasErrors = true;
		}
		else if (!suite.hasParent) {
			const session = this.sessions[suite.sessionId || ''];

			if (!session) {
				if (!this.serveOnly) {
					const charm = this.charm;
					charm.display('bright');
					charm.foreground('yellow');
					charm.write('BUG: suiteEnd was received for invalid session ' + suite.sessionId);
					charm.display('reset');
					charm.write('\n');
				}

				return;
			}

			if (session.coverage) {
				this.charm.write('\n');
				this.createCoverageReport(this.reportType, session.coverage);
			}
			else {
				const charm = this.charm;
				charm.write('No unit test coverage for ' + suite.name);
				charm.display('reset');
				charm.write('\n');
			}

			let name = suite.name;
			let hasError = (function hasError(suite): any {
				return suite.tests ? (suite.error || suite.tests.some(hasError)) : false;
			})(suite);
			let numFailedTests = suite.numFailedTests;
			let numTests = suite.numTests;
			let numSkippedTests = suite.numSkippedTests;

			let summary = nodeUtil.format('%s: %d/%d tests failed', name, numFailedTests, numTests);
			if (numSkippedTests) {
				summary += ' (' + numSkippedTests + ' skipped)';
			}

			if (hasError) {
				summary += '; fatal error occurred';
			}

			const charm = this.charm;
			charm.display('bright');
			charm.foreground(numFailedTests || hasError > 0 ? 'red' : 'green');
			charm.write(summary);
			charm.display('reset');
			charm.write('\n');
		}
	}

	@eventHandler()
	suiteStart(suite: Suite) {
		if (!suite.hasParent) {
			this.sessions[suite.sessionId || ''] = { suite: suite };
			if (suite.sessionId) {
				this.charm.write('\n');
				this.charm.write('‣ Created remote session ' + suite.name + ' (' + suite.sessionId + ')\n');
			}
		}
	}

	@eventHandler()
	testEnd(test: Test) {
		const charm = this.charm;
		if (test.error) {
			charm.foreground('red');
			charm.write('× ' + test.id);
			charm.write(' (' + (test.timeElapsed / 1000) + 's)');
			charm.write('\n');
			charm.display('reset');
			charm.foreground('red');
			charm.write(this.formatError(test.error));
			charm.display('reset');
			charm.write('\n');
		}
		else if (test.skipped) {
			if (!this.hideSkipped) {
				charm.foreground('magenta');
				charm.write('~ ' + test.id);
				charm.display('reset');
				charm.write(' (' + (test.skipped || 'skipped') + ')');
				charm.display('reset');
				charm.write('\n');
			}
		}
		else {
			if (!this.hidePassed) {
				charm.foreground('green');
				charm.write('✓ ' + test.id);
				charm.display('reset');
				charm.write(' (' + (test.timeElapsed / 1000) + 's)');
				charm.display('reset');
				charm.write('\n');
			}
		}
	}

	@eventHandler()
	tunnelDownloadProgress(message: TunnelMessage) {
		const progress = message.progress!;
		this.charm.write('Tunnel download: ' + (progress.received / progress.total * 100).toFixed(3) + '%\r');
	}

	@eventHandler()
	tunnelStart() {
		this.charm.write('Tunnel started\n');
	}

	@eventHandler()
	tunnelStatus(message: TunnelMessage) {
		this.charm.write(message.status + '\x1b[K\r');
	}
}