import { inspect } from 'util';
import { main } from '../common.js';
import * as lib from './lib.js';

/**
 * The main Google Cloud Function
 * 
 * @param {Object} context - The event context
 * @param {Object} data - The event data
 */
export function entryPoint(event, cb) {
	console.log(`Reading options from data:\n${inspect(event, {depth: 5})}`);

	main(lib, console, {
		event: event.data,
		context: event.context,
		// Shim
		callback: cb
	});
}