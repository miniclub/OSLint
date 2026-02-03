import * as fs from "fs";
import * as path from "path";
import { TextDocument } from "vscode-languageserver-textdocument";
import { Position, Range } from "vscode-languageserver";
import { URI } from "vscode-uri";

import { compressedline, compressedresult } from "../utils/types";
import { colorRoutineLine, isRoutineHeader, routineheadertype } from "../parse/routineheader/parseroutineheader";
import * as ld from "../utils/languageDefinitions";
import { lexerLanguages } from "../utils/lexerLanguages";

declare const __non_webpack_require__: NodeRequire | undefined;

type RuleId = "syntax" | "undefined-vars" | "routine-header";
type Severity = "error" | "warning";

type LintDiagnostic = {
	file: string;
	message: string;
	severity: Severity;
	rule: RuleId;
	range: Range;
};

type CliOptions = {
	files: string[];
	format: "text" | "json";
	languageId?: string;
	suppressSyntax: Set<string>;
	checkSyntax: boolean;
	checkUndefinedVars: boolean;
	checkRoutineHeader: boolean;
};

type LexerModule = {
	Tokenize: (text: string, moniker: string, _unused: boolean, flags: number) => compressedline[];
	GetLanguageAttributes: (moniker: string) => string[];
};

// flags to pass to Tokenize
const IPARSE_UDL_EXPLICIT = 0x0001; // require variable declaration (#dim)
const IPARSE_UDL_EXPERT = 0x4000; // this stops the SYSTEM class keyword from being colored as a syntax error
const IPARSE_COS_U2 = 0x10000; // accept U2 syntax
const IPARSE_UDL_TRACK = 0x20000; // enable variable tracking
// these flags are only passed for HTML documents
const IPARSE_ALL_CSPEXTENSIONS = 0x0400; // all parsers: recognize CSP extensions like #(..)#
const IPARSE_HTML_CSPMODE = 0x0800; // HTML parser: is in CSP mode

const STANDARDPARSEFLAGS = IPARSE_UDL_EXPLICIT + IPARSE_UDL_EXPERT + IPARSE_UDL_TRACK;
const SYNTAX_ERROR = "Syntax error";

function loadLexer(): LexerModule {
	const platform = process.platform;
	const arch = process.arch;
	const libDir = path.resolve(__dirname, "..", "lib");
	const nodeRequire: NodeRequire =
		typeof __non_webpack_require__ === "function" ? __non_webpack_require__ : require;

	const candidates: string[] = [];
	if (platform === "win32" || platform === "darwin" || platform === "linux") {
		candidates.push(`${platform}-${arch}-isclexer.node`);
		if (platform === "linux") {
			candidates.push(`alpine-${arch}-isclexer.node`);
		}
	}

	for (const filename of candidates) {
		const fullPath = path.join(libDir, filename);
		if (fs.existsSync(fullPath)) {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			return nodeRequire(fullPath) as LexerModule;
		}
	}

	throw new Error(`Unsupported platform or missing lexer binary in ${libDir}`);
}

function getFirstLine(documenttext: string): string {
	const poslf = documenttext.indexOf("\n");
	if (poslf === -1) {
		return documenttext;
	}
	if (poslf > 0 && documenttext.charAt(poslf - 1) === "\r") {
		return documenttext.slice(0, poslf - 1);
	}
	return documenttext.slice(0, poslf);
}

function parseDocumentForLint(
	lexer: LexerModule,
	languageId: string,
	fileExt: string,
	text: string
): compressedresult {
	let moniker = "COS";
	let flags = STANDARDPARSEFLAGS;

	if (languageId === "objectscript-class") {
		moniker = "CLS";
	} else if (languageId === "objectscript-csp") {
		moniker = "HTML";
	} else if (languageId === "objectscript-int" || (languageId === "objectscript" && fileExt === "int")) {
		moniker = "INT";
	}

	if ((moniker === "COS" || moniker === "INT") && isRoutineHeader(text)) {
		const firstline = getFirstLine(text);
		const routinelinecoloring: routineheadertype = colorRoutineLine(firstline);

		if (routinelinecoloring?.routineheaderinfo?.languagemode == 10) {
			flags += IPARSE_COS_U2;
		}

		const doctoparse = " ".repeat(firstline.length) + text.slice(firstline.length);
		const restcolors: compressedline[] = lexer.Tokenize(doctoparse, moniker, false, flags);
		restcolors[0] = routinelinecoloring.compressedline;
		return { compressedlinearray: restcolors, routineheaderinfo: routinelinecoloring.routineheaderinfo };
	}

	flags += moniker === "HTML" ? IPARSE_ALL_CSPEXTENSIONS + IPARSE_HTML_CSPMODE : 0;
	return { compressedlinearray: lexer.Tokenize(text, moniker, false, flags) };
}

function normalizeErrorDesc(e?: string): string {
	return !e || e.includes("HRESULT") ? SYNTAX_ERROR : e[0].toUpperCase() + e.slice(1).replace(/'/g, "\"");
}

function detectLanguageId(filePath: string, explicit?: string): string {
	if (explicit) {
		return explicit;
	}
	const ext = path.extname(filePath).slice(1).toLowerCase();
	switch (ext) {
		case "cls":
			return "objectscript-class";
		case "mac":
			return "objectscript";
		case "int":
			return "objectscript-int";
		case "inc":
			return "objectscript-macros";
		case "csp":
		case "csr":
			return "objectscript-csp";
		default:
			throw new Error(`Unsupported file extension ".${ext}"`);
	}
}

function collectDiagnostics(
	filePath: string,
	doc: TextDocument,
	parsed: compressedline[],
	options: CliOptions
): LintDiagnostic[] {
	const diagnostics: LintDiagnostic[] = [];

	const reportSyntaxErrors = (languageIndex: number): boolean => {
		const moniker = lexerLanguages.find(ll => ll.index === languageIndex)?.moniker;
		return !moniker || !options.suppressSyntax.has(moniker);
	};

	const firstlineisroutine: boolean =
		parsed.length > 0 && parsed[0].length > 0 &&
		parsed[0][0].l == ld.cos_langindex && parsed[0][0].s == ld.cos_command_attrindex &&
		doc.getText(Range.create(0, parsed[0][0].p, 0, parsed[0][0].p + parsed[0][0].c)).toLowerCase() === "routine";

	if (
		options.checkRoutineHeader &&
		!firstlineisroutine &&
		["objectscript", "objectscript-int", "objectscript-macros"].includes(doc.languageId)
	) {
		diagnostics.push({
			file: filePath,
			severity: "error",
			rule: "routine-header",
			range: Range.create(0, 0, 0, 0),
			message: "ROUTINE header is required"
		});
	} else if (options.checkSyntax && firstlineisroutine) {
		for (let t = 0; t < parsed[0].length; t++) {
			if (parsed[0][t].s == ld.error_attrindex && reportSyntaxErrors(parsed[0][t].l)) {
				const errorDesc = normalizeErrorDesc(parsed[0][t].e);
				if (
					t > 0 && parsed[0][t - 1].s == ld.error_attrindex &&
					diagnostics.length &&
					[SYNTAX_ERROR, diagnostics[diagnostics.length - 1].message].includes(errorDesc)
				) {
					diagnostics[diagnostics.length - 1].range.end = Position.create(0, parsed[0][t].p + parsed[0][t].c);
				} else {
					diagnostics.push({
						file: filePath,
						severity: "error",
						rule: "syntax",
						range: Range.create(0, parsed[0][t].p, 0, parsed[0][t].p + parsed[0][t].c),
						message: errorDesc
					});
				}
			}
		}
	}

	const startline = firstlineisroutine ? 1 : 0;
	let lastErrWasWhitespace = false;
	let ifZeroStartPos: Position | undefined;
	const ifZeroStart = /^\s*#if\s+(?:0|"0")(?:$|\s)/i;
	const ifZeroEnd = /^\s*#elseif\s+|(?:#else|#endif)(?:$|\s)/i;

	for (let i = startline; i < parsed.length; i++) {
		if (!parsed[i]?.length) {
			continue;
		}

		const lineText = doc.getText(Range.create(i, 0, i + 1, 0));
		if (doc.languageId != "objectscript-int" && !ifZeroStartPos) {
			const ifZeroStartMatch = lineText.match(ifZeroStart);
			if (ifZeroStartMatch) {
				ifZeroStartPos = Position.create(i, ifZeroStartMatch[0].length);
				continue;
			}
		} else if (ifZeroStartPos && ifZeroEnd.test(lineText)) {
			ifZeroStartPos = undefined;
			continue;
		}

		for (let j = 0; j < parsed[i].length; j++) {
			const symbolstart = parsed[i][j].p;
			const symbolend = parsed[i][j].p + parsed[i][j].c;

			if (options.checkSyntax && !ifZeroStartPos) {
				if (j > 0 && parsed[i][j].l === parsed[i][j - 1].l && parsed[i][j].s === parsed[i][j - 1].s) {
					if (parsed[i][j].s === ld.error_attrindex && reportSyntaxErrors(parsed[i][j].l)) {
						const errorDesc = normalizeErrorDesc(parsed[i][j].e);
						const errorRange = Range.create(i, symbolstart, i, symbolend);
						if (doc.getText(errorRange).trim()) {
							if (
								!lastErrWasWhitespace &&
								parsed[i][j].l == parsed[i][j - 1].l &&
								diagnostics.length &&
								[SYNTAX_ERROR, diagnostics[diagnostics.length - 1].message].includes(errorDesc)
							) {
								diagnostics[diagnostics.length - 1].range.end = Position.create(i, symbolend);
							} else {
								diagnostics.push({
									file: filePath,
									severity: "error",
									rule: "syntax",
									range: errorRange,
									message: errorDesc
								});
							}
						}
						lastErrWasWhitespace = false;
					} else {
						lastErrWasWhitespace = true;
					}
				} else if (parsed[i][j].s === ld.error_attrindex && reportSyntaxErrors(parsed[i][j].l)) {
					const errorRange = Range.create(i, symbolstart, i, symbolend);
					if (doc.getText(errorRange).trim()) {
						diagnostics.push({
							file: filePath,
							severity: "error",
							rule: "syntax",
							range: errorRange,
							message: normalizeErrorDesc(parsed[i][j].e)
						});
						lastErrWasWhitespace = false;
					} else {
						lastErrWasWhitespace = true;
					}
				}
			}

			if (
				options.checkUndefinedVars &&
				!ifZeroStartPos &&
				parsed[i][j].l == ld.cos_langindex &&
				parsed[i][j].s == ld.cos_otw_attrindex
			) {
				const varrange = Range.create(i, symbolstart, i, symbolend);
				diagnostics.push({
					file: filePath,
					severity: "warning",
					rule: "undefined-vars",
					range: varrange,
					message: `Local variable "${doc.getText(varrange)}" may be undefined`
				});
			}
		}
	}

	return diagnostics;
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		files: [],
		format: "text",
		suppressSyntax: new Set(),
		checkSyntax: true,
		checkUndefinedVars: true,
		checkRoutineHeader: true
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") {
			printUsage();
			process.exit(0);
		} else if (arg === "--file" || arg === "-f") {
			const next = argv[++i];
			if (!next) {
				throw new Error("--file requires a path");
			}
			options.files.push(next);
		} else if (arg === "--format") {
			const next = argv[++i];
			if (next !== "text" && next !== "json") {
				throw new Error("--format must be text or json");
			}
			options.format = next;
		} else if (arg === "--language" || arg === "-l") {
			const next = argv[++i];
			if (!next) {
				throw new Error("--language requires a languageId");
			}
			options.languageId = next;
		} else if (arg === "--suppress-syntax") {
			const next = argv[++i];
			if (!next) {
				throw new Error("--suppress-syntax requires a comma-separated list");
			}
			next.split(",").map(s => s.trim().toUpperCase()).filter(Boolean).forEach(s => options.suppressSyntax.add(s));
		} else if (arg === "--no-syntax") {
			options.checkSyntax = false;
		} else if (arg === "--no-undefined-vars") {
			options.checkUndefinedVars = false;
		} else if (arg === "--no-routine-header") {
			options.checkRoutineHeader = false;
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown argument: ${arg}`);
		} else {
			options.files.push(arg);
		}
	}

	if (options.files.length === 0) {
		throw new Error("No input files provided");
	}

	return options;
}

function printUsage() {
	const lines = [
		"Usage:",
		"  node server/out/lint.js [options] <file...>",
		"",
		"Options:",
		"  -f, --file <path>           Add a file to lint (repeatable)",
		"  -l, --language <languageId> Override languageId (e.g. objectscript-class)",
		"  --format <text|json>        Output format (default: text)",
		"  --suppress-syntax <list>    Comma-separated monikers to suppress (e.g. COS,SQL)",
		"  --no-syntax                 Disable syntax error checks",
		"  --no-undefined-vars         Disable undefined variable checks",
		"  --no-routine-header         Disable ROUTINE header check",
		"  -h, --help                  Show this help"
	];
	console.log(lines.join("\n"));
}

function formatText(diags: LintDiagnostic[]): string {
	return diags.map(d => {
		const line = d.range.start.line + 1;
		const col = d.range.start.character + 1;
		return `${d.file}:${line}:${col}: ${d.severity}: ${d.message} (${d.rule})`;
	}).join("\n");
}

function formatJson(diags: LintDiagnostic[]): string {
	return JSON.stringify(diags.map(d => ({
		file: d.file,
		severity: d.severity,
		rule: d.rule,
		message: d.message,
		range: {
			start: { line: d.range.start.line + 1, character: d.range.start.character + 1 },
			end: { line: d.range.end.line + 1, character: d.range.end.character + 1 }
		}
	})), null, 2);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const lexer = loadLexer();
	const allDiagnostics: LintDiagnostic[] = [];

	for (const file of options.files) {
		const fullPath = path.resolve(file);
		const text = fs.readFileSync(fullPath, "utf8");
		const languageId = detectLanguageId(fullPath, options.languageId);
		const fileExt = path.extname(fullPath).slice(1).toLowerCase();
		const parsed = parseDocumentForLint(lexer, languageId, fileExt, text).compressedlinearray;
		const uri = URI.file(fullPath).toString();
		const doc = TextDocument.create(uri, languageId, 1, text);
		allDiagnostics.push(...collectDiagnostics(fullPath, doc, parsed, options));
	}

	const output = options.format === "json" ? formatJson(allDiagnostics) : formatText(allDiagnostics);
	if (output.length) {
		console.log(output);
	}

	const errorCount = allDiagnostics.filter(d => d.severity === "error").length;
	const warningCount = allDiagnostics.filter(d => d.severity === "warning").length;
	process.exitCode = errorCount > 0 ? 1 : warningCount > 0 ? 2 : 0;
}

main().catch(err => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(2);
});
