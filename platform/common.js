'use strict';

process.env['NODE_ENV'] = 'production';

import { execFile, spawn } from 'child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, unlink } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createGzip, Z_BEST_COMPRESSION } from 'zlib';
import { checkM3u } from './lib';

/** @type string **/
const tempDir = process.env['TEMP'] || tmpdir();
const download = join(tempDir, 'download');

let log = console.log;
let downloadFunc, uploadFunc;

const extensionRegex = /\.(\w+)$/;

function getExtension(filename) {
	return filename.match(extensionRegex)[1];
}

const outputDir = join(tempDir, 'outputs');

if (!existsSync(outputDir))
	mkdirSync(outputDir);

const {
	USE_GZIP,
	MIME_TYPES,
	VIDEO_MAX_DURATION,
} = process.env;

const FFMPEG_ARGS = '-ss 00:00:1.000 -vframes 1 out.jpg'
const DESTINATION_BUCKET = 'clanhq-stage.appspot.com'
const mimeTypes = {"jpg":"image/jpg","mp4":"video/mp4"};
const useGzip = USE_GZIP === 'true';
const videoMaxDuration = 5000;

/**
 * Downloads the file to the local temp directory
 *
 * @param {{bucket: !string, key: !string}} sourceLocation - The location of the remote file
 * @returns {Promise}
 */
function downloadFile({bucket, key}) {
	return new Promise((resolve, reject) => {
		log(`Starting download: ${bucket} / ${key}`);

		downloadFunc(bucket, key)
			.on('end', () => {
				log('Download finished');
				resolve();
			})
			.on('error', reject)
			.pipe(createWriteStream(download));
	});
}

/**
 * Runs FFprobe and ensures that the input file has a valid stream and meets the maximum duration threshold.
 *
 * @returns {Promise}
 */
function ffprobe() {
	log('Starting FFprobe');

	return new Promise((resolve, reject) => {
		const args = [
			'-v', 'quiet',
			'-print_format', 'json',
			'-show_format',
			'-show_streams',
			'-i', 'download'
		];
		const opts = {
			cwd: tempDir
		};
		const cb = (error, stdout) => {
			if (error)
				reject(error);

			log(stdout);

			const {streams, format} = JSON.parse(stdout);

			const hasVideoStream = streams.some(({codec_type, duration}) =>
				codec_type === 'video' &&
				(duration || format.duration) <= videoMaxDuration
			);

			if (!hasVideoStream)
				reject('FFprobe: no valid video stream found');
			else {
				log('Valid video stream found. FFprobe finished.');
				resolve();  
			}
		};

		execFile('ffprobe', args, opts, cb)
			.on('error', reject);
	});
}

/**
 * Runs the FFmpeg executable
 *
 * @param {string} keyPrefix - The prefix for the key (filename minus extension)
 * @returns {Promise}
 */
function ffmpeg(keyPrefix) {
	log('Starting FFmpeg');

	return new Promise((resolve, reject) => {
		const args = [
			'-y',
			'-loglevel', 'warning',
			'-i', '../download',
			...FFMPEG_ARGS
			.replace('$KEY_PREFIX', keyPrefix)
			.split(' ')
		];
		const opts = {
			cwd: outputDir
		};
		
		spawn('ffmpeg', args, opts)
			.on('message', msg => log(msg))
			.on('error', reject)
			.on('close', resolve);
	});
}

/**
 * Deletes a file
 *
 * @param {!string} localFilePath - The location of the local file
 * @returns {Promise<void>}
 */
function removeFile(localFilePath) {
	log(`Deleting ${localFilePath}`);

	return new Promise((resolve, reject) => {
		unlink(
			localFilePath,
			(err, result) => err ? reject(err) : resolve(result)
		);
	});
}

/**
 * Encodes the file, if gzip is enabled
 *
 * @param {!string} filename - The filename of the file to encode
 * @param {boolean} gzip - Whether to GZIP-encode the file, or pass it through
 * @param {!Array<string>} rmFiles - The files to remove after the operation is complete
 * @returns {Promise<module:fs~ReadStream>}
 */
function encode(filename, gzip, rmFiles) {
	return new Promise((resolve) => {
		const readStream = createReadStream(filename);

		if (!gzip)
			return resolve(readStream);

		log(`GZIP encoding ${filename}`);
		const gzipFilename = filename + '.gzip';

		rmFiles.push(gzipFilename);

		const gzipWriteStream = createWriteStream(gzipFilename);

		gzipWriteStream.on('finish', () => resolve(createReadStream(gzipFilename)));

		readStream
			.pipe(createGzip({level: Z_BEST_COMPRESSION}))
			.pipe(gzipWriteStream);
	});
}

/**
 * Transforms, uploads, and deletes an output file
 *
 * @param {!string} keyPrefix - The filename without the extension
 * @param {!string} filename - A file from the output directory
 * @returns {Promise}
 */
async function uploadFile(keyPrefix, filename) {
	const extension = getExtension(filename);
	const mimeType = mimeTypes[extension];
	const fileFullPath = join(outputDir, filename);
	const rmFiles = [fileFullPath];

	const fileStream = await encode(fileFullPath, useGzip, rmFiles);

	log(`Uploading ${keyPrefix}.${extension}`);

	await uploadFunc(
		DESTINATION_BUCKET,
		`${keyPrefix}.${extension}`,
		fileStream,
		useGzip ? 'gzip' : null,
		mimeType
	);

	log(`${mimeType} ${filename} complete.`);

	await Promise.all(
		rmFiles.map(removeFile)
	);
}

/**
 * Uploads the output files
 *
 * @param {!string} keyPrefix - The prefix for the key (filename minus extension)
 * @returns {Promise}
 */

async function uploadFiles(keyPrefix) {
	log(`Beginning Upload ${keyPrefix}`);
	log(`Beginning Upload ${outputDir}`);
	const files = readdirSync(outputDir)
	for (const i = 0; i < files.length; i++) {
		const filename = files[i]
		console.log(`Found: ${filename}`); 
		await uploadFile(keyPrefix, filename)
	}
	log(`Done uploading`);
}

/**
 * The main function
 *
 * @param {!object} library - The platform library
 * @param {!function} library.getDownloadStream
 * @param {!function} library.getFileLocation
 * @param {!function} library.uploadToBucket
 * @param {!object} logger - The platform logger
 * @param {!function} logger.log - The logging function
 * @param {!object} invocation - The invocation
 * @param {!object} invocation.event
 * @param {!function} invocation.callback
 */
export async function main(library, logger, invocation) {
	log = logger.log;
	downloadFunc = library.getDownloadStream;
	uploadFunc = library.uploadToBucket;

	log(`Invoction: ${invocation.event}`);

	const sourceLocation = library.getFileLocation(invocation.event);

	const parts = sourceLocation.key.split('.')
	const extension = parts[parts.length - 1]
	if (extension !== 'mp4') {
		invocation.callback(null)
		return
	}

	const keyPrefix = sourceLocation.key.replace(/\.[^/.]+$/, '');

	let error = null;

	try {
		await downloadFile(sourceLocation);
		await checkM3u(download);
		await ffprobe();
		await ffmpeg(keyPrefix);
		await uploadFiles(keyPrefix);
		await removeFile(download);
	} catch (e) {
		error = e;
	}

	invocation.callback(error);
}
