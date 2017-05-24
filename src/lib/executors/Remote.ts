import Browser, { Config as BaseConfig, Events } from './Browser';
import { initialize } from './Executor';
import { parseValue } from '../common/util';
import Dom from '../reporters/Dom';

/**
 * An executor for running suites in a remote browser. This executor is intended to be started and managed by Intern
 * itself rather than by end-user runner scripts.
 */
export default class Remote extends Browser<Events, Config> {
	static initialize(config?: Partial<Config>) {
		return initialize<Events, Config, Remote>(Remote, config);
	}

	constructor(config?: Partial<Config>) {
		super(<Config>{
			reporters: [{ name: 'dom' }],
			runInSync: false,
			sessionId: ''
		});

		this.registerReporter('dom', Dom);

		if (config) {
			this.configure(config);
		}
	}

	protected _processOption(name: keyof Config, value: any, addToExisting: boolean) {
		switch (name) {
			case 'runInSync':
				this._setOption(name, parseValue(name, value, 'boolean'));
				break;

			case 'sessionId':
				this._setOption(name, parseValue(name, value, 'string'));
				break;

			case 'socketPort':
				this._setOption(name, parseValue(name, value, 'number'));
				break;

			default:
				super._processOption(name, value, addToExisting);
				break;
		}
	}
}

export { Events };

export interface Config extends BaseConfig {
	runInSync: boolean;
	sessionId: string;
	socketPort?: number;
}