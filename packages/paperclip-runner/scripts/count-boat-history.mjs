#!/usr/bin/env node
// Count Boat commands for one gate box/run from an exported Boat history JSON document.
// Exits nonzero on a bridge queue listing or when no matching history rows exist.
import fs from 'node:fs';

function fail(message, code = 2) { console.error(message); process.exitCode = code; }
function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--box') out.box = argv[++i];
    else if (argv[i] === '--run') out.run = argv[++i];
    else if (argv[i] === '--history') out.history = argv[++i];
    else if (argv[i] === '--transport-log') out.transportLog = argv[++i];
    else if (argv[i] === '--require-prp') out.requirePrp = true;
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  return out;
}
function scalar(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (value && typeof value === 'object') return String(value.id ?? value.name ?? value.key ?? '');
  return '';
}
function nested(row, keys) {
  for (const key of keys) if (row?.[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
}
function commandKind(row) {
  const command = row.command && typeof row.command === 'object' ? row.command : {};
  const input = row.input && typeof row.input === 'object' ? row.input : {};
  const value = nested(command, ['kind', 'commandKind', 'operation', 'method'])
    ?? nested(row, ['commandKind', 'kind', 'operation', 'method', 'type'])
    ?? nested(input, ['kind', 'commandKind', 'operation', 'method']);
  return scalar(value) || 'unknown';
}
function commandText(row) {
  const parts = [];
  const push = value => {
    if (typeof value === 'string') parts.push(value);
    else if (Array.isArray(value)) parts.push(value.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '));
    else if (value && typeof value === 'object') {
      for (const key of ['command', 'cmd', 'path', 'directory', 'dir', 'script', 'argv', 'args', 'input']) {
        if (value[key] !== undefined) push(value[key]);
      }
    }
  };
  push(row.command); push(row.input); push(row.args); push(row.commandLine); push(row.argv);
  return parts.join('\n');
}
function isBridgeQueueListing(row) {
  const kind = commandKind(row).toLowerCase();
  const text = commandText(row).toLowerCase();
  const isListKind = /(^|[._-])(list|ls|listdir|readdir|find)([._-]|$)/.test(kind);
  const targetsQueue = /paperclip_bridge_queue_dir|(?:^|[\\/])requests(?:[\\/\s"']|$)|bridge[-_ ]queue[^\n]*requests/.test(text);
  const usesListCommand = /(^|[\s;&|])(?:ls|find|dir|get-childitem|list|listdir|readdir)(?:[\s;&|]|$)/.test(text) || isListKind;
  return targetsQueue && usesListCommand;
}
function rowsFrom(document) {
  if (Array.isArray(document)) return document;
  if (Array.isArray(document?.history)) return document.history;
  if (Array.isArray(document?.commands)) return document.commands;
  if (Array.isArray(document?.entries)) return document.entries;
  throw new Error('history JSON must be an array or contain history[], commands[], or entries[]');
}
function transportRowsFrom(text) {
  try {
    const document = JSON.parse(text);
    if (Array.isArray(document)) return document;
    for (const key of ['events', 'spans', 'records', 'entries']) if (Array.isArray(document?.[key])) return document[key];
    return [document];
  } catch {
    return text.split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); } catch { throw new Error(`transport log line ${index + 1} is not JSON`); }
    });
  }
}
function fields(row) { return [row, row?.attributes, row?.metadata, row?.payload, row?.data].filter(value => value && typeof value === 'object'); }
function getField(row, names) {
  for (const object of fields(row)) for (const name of names) if (object[name] !== undefined && object[name] !== null) return object[name];
  return undefined;
}
function timestamp(row) {
  const value = getField(row, ['timestamp', 'at', 'time', 'ts']);
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : null; }
  return null;
}
function verifyPrpTransport(file, run) {
  if (!file) throw new Error('--require-prp requires --transport-log');
  const rows = transportRowsFrom(fs.readFileSync(file, 'utf8'));
  const relevant = rows.filter(row => scalar(getField(row, ['runId', 'run_id', 'gateRunId'])) === run);
  const prp = relevant.filter(row => String(getField(row, ['transport', 'transportMode']) || '').toLowerCase() === 'prp');
  if (!prp.length) throw new Error(`transport log has no transport=prp row for run=${run}`);
  if (relevant.some(row => {
    const mode = String(getField(row, ['transport', 'transportMode']) || '').toLowerCase();
    const reason = getField(row, ['fallbackReason', 'fallback_reason']);
    const started = getField(row, ['bridgeStarted', 'bridge_started']);
    return mode === 'bridge' || (typeof reason === 'string' && reason.length > 0) || started === true;
  })) throw new Error(`run=${run} selected bridge/fallback or started the callback bridge despite the PRP gate`);
  const prpTime = Math.min(...prp.map(timestamp).filter(value => value !== null));
  const sessionIds = new Set(prp.map(row => scalar(getField(row, ['sessionId', 'session_id']))).filter(Boolean));
  for (const row of rows) {
    const session = scalar(getField(row, ['sessionId', 'session_id']));
    if (!session || !sessionIds.has(session)) continue;
    const mode = String(getField(row, ['transport', 'transportMode']) || '').toLowerCase();
    const reason = getField(row, ['fallbackReason', 'fallback_reason']);
    const started = getField(row, ['bridgeStarted', 'bridge_started']);
    if (mode === 'bridge' || (typeof reason === 'string' && reason.length > 0) || started === true) {
      const eventTime = timestamp(row);
      if (prpTime === Infinity || eventTime === null || eventTime >= prpTime) throw new Error(`session=${session} has a bridge/fallback event after (or unorderable against) PRP selection`);
    }
  }
  if (prp.some(row => !scalar(getField(row, ['sessionId', 'session_id'])))) throw new Error(`transport=prp evidence for run=${run} lacks sessionId; cannot prove reconnect did not start the bridge`);
  return { runId: run, transport: 'prp', prpRows: prp.length, sessions: [...sessionIds], bridgeStartedAfterPrp: 0 };
}
function matches(row, box, run) {
  const rowBox = scalar(nested(row, ['box', 'boxId', 'boxName']) ?? nested(row.context, ['box', 'boxId', 'boxName']) ?? nested(row.metadata, ['box', 'boxId', 'boxName']));
  const rowRun = scalar(nested(row, ['run', 'runId', 'gateRunId']) ?? nested(row.context, ['run', 'runId', 'gateRunId']) ?? nested(row.metadata, ['run', 'runId', 'gateRunId']));
  return rowBox === box && rowRun === run;
}

try {
  const options = args(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: count-boat-history.mjs --box BOX --run RUN --history HISTORY.json [--require-prp --transport-log RUN-TRANSPORT.jsonl]\nHistory rows require box/run identifiers. With --require-prp, transport rows require runId, sessionId and transport=prp; bridge/fallback after PRP is rejected.');
  } else {
    if (!options.box || !options.run || !options.history) throw new Error('required: --box BOX --run RUN --history HISTORY.json');
    const text = options.history === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(options.history, 'utf8');
    const rows = rowsFrom(JSON.parse(text)).filter(row => matches(row, options.box, options.run));
    if (rows.length === 0) { fail(`No Boat history rows matched box=${options.box} run=${options.run}; zero counts are not evidence.`, 2); }
    else {
      const counts = {};
      for (const row of rows) { const kind = commandKind(row); counts[kind] = (counts[kind] || 0) + 1; }
      const bridgeQueueLists = rows.filter(isBridgeQueueListing).length;
      const transportCheck = options.requirePrp ? verifyPrpTransport(options.transportLog, options.run) : undefined;
      console.log(JSON.stringify({ box: options.box, run: options.run, historyRows: rows.length, commandsByKind: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))), bridgeQueueLists, ...(transportCheck ? { transportCheck } : {}) }, null, 2));
      if (bridgeQueueLists !== 0) fail(`Gate check failed: ${bridgeQueueLists} bridge queue list command(s) found.`, 1);
    }
  }
} catch (error) { fail(error.message || String(error), 2); }
