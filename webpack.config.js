//@ts-check

'use strict';

const withDefaults = require('./shared.webpack.config');
const path = require('path');

module.exports = withDefaults({
	context: path.join(__dirname),
	entry: {
		lint: './src/cli/lint.ts',
	},
	output: {
		filename: 'lint.js',
		path: path.join(__dirname, 'out')
	}
});
