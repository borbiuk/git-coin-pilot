// Delivery table for the schedule pilot (checklist item 4, ADR 0005 D1).
//
// Usage: node analyze-pilot.mjs pilot-5m.csv pilot-15m.csv pilot-30m.csv [--from ISO] [--to ISO] [--json]
//
// Input: the CSV files written by pilot-5m.yml, pilot-15m.yml and pilot-30m.yml (header in the files).
// Only rows with event "schedule" and run_attempt 1 count. The time of a run is created_at, or logged_at
// when created_at is empty. By default the window runs from the first to the last row of all files. Pass
// --from with the time you pushed the workflows, so a late start counts as missed ticks.
// The script has no dependencies. It prints Markdown (or JSON with --json) and does not choose for you.

import { readFileSync } from 'node:fs';
import process from 'node:process';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;

// Cron slots of the three workflows: OFFSET + n * PERIOD minutes after the hour
const GRIDS = {
	'pilot-5m': { periodMin: 5, offsetMin: 2 },
	'pilot-15m': { periodMin: 15, offsetMin: 3 },
	'pilot-30m': { periodMin: 30, offsetMin: 7 },
};

function parseArgs(argv) {
	const args = { files: [], from: null, to: null, json: false };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--json') {
			args.json = true;
		} else if (arg === '--from' || arg === '--to') {
			const value = Date.parse(argv[++i] ?? '');
			if (Number.isNaN(value)) {
				throw new Error(
					`${arg} needs an ISO time, for example 2026-11-02T09:00:00Z`
				);
			}
			args[arg.slice(2)] = value;
		} else {
			args.files.push(arg);
		}
	}
	if (args.files.length === 0) {
		throw new Error('Pass at least one pilot CSV file.');
	}
	return args;
}

function readRuns(file) {
	const lines = readFileSync(file, 'utf8')
		.split('\n')
		.filter((line) => line.trim() !== '');
	if (lines.length === 0) {
		throw new Error(`${file} is empty.`);
	}
	const header = lines[0].split(',');
	const seen = new Set();
	const runs = [];
	let name = null;
	for (const line of lines.slice(1)) {
		const cells = line.split(',');
		const row = Object.fromEntries(
			header.map((key, i) => [key, cells[i] ?? ''])
		);
		name = name ?? row.workflow;
		if (
			row.event !== 'schedule' ||
			row.run_attempt !== '1' ||
			seen.has(row.run_id)
		) {
			continue;
		}
		seen.add(row.run_id);
		const time = Date.parse(row.created_at || row.logged_at);
		if (Number.isNaN(time)) {
			continue;
		}
		const logged = Date.parse(row.logged_at);
		const created = Date.parse(row.created_at);
		runs.push({
			time,
			startLagS:
				Number.isNaN(logged) || Number.isNaN(created)
					? null
					: (logged - created) / 1000,
		});
	}
	runs.sort((a, b) => a.time - b.time);
	return { name, runs };
}

// First cron slot (epoch ms) at or after t
function slotAtOrAfter(t, grid) {
	const base = Math.ceil(
		(t - grid.offsetMin * MINUTE) / (grid.periodMin * MINUTE)
	);
	return grid.offsetMin * MINUTE + base * grid.periodMin * MINUTE;
}

function slotAtOrBefore(t, grid) {
	const base = Math.floor(
		(t - grid.offsetMin * MINUTE) / (grid.periodMin * MINUTE)
	);
	return grid.offsetMin * MINUTE + base * grid.periodMin * MINUTE;
}

function percentile(sorted, p) {
	if (sorted.length === 0) {
		return null;
	}
	const index = (sorted.length - 1) * p;
	const low = Math.floor(index);
	const high = Math.ceil(index);
	return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

function sortedNumbers(values) {
	return values.filter((v) => v !== null).sort((a, b) => a - b);
}

function round(value, digits = 1) {
	return value === null ? null : Number(value.toFixed(digits));
}

function analyze(name, runs, from, to) {
	const grid = GRIDS[name];
	if (!grid) {
		throw new Error(
			`Unknown workflow "${name}". Expected one of: ${Object.keys(GRIDS).join(', ')}.`
		);
	}
	const inWindow = runs.filter((run) => run.time >= from && run.time <= to);
	const first = slotAtOrAfter(from, grid);
	const ticks =
		first > to
			? 0
			: Math.floor((to - first) / (grid.periodMin * MINUTE)) + 1;

	const gaps = sortedNumbers(
		inWindow
			.slice(1)
			.map((run, i) => (run.time - inWindow[i].time) / MINUTE)
	);
	const delays = sortedNumbers(
		inWindow.map(
			(run) => (run.time - slotAtOrBefore(run.time, grid)) / MINUTE
		)
	);
	const lags = sortedNumbers(inWindow.map((run) => run.startLagS));
	const slotsWithRun = new Set(
		inWindow.map((run) => slotAtOrBefore(run.time, grid))
	).size;

	// Runs per UTC day, only for days that lie fully inside the window
	const perDay = new Map();
	for (const run of inWindow) {
		const day = Math.floor(run.time / DAY);
		perDay.set(day, (perDay.get(day) ?? 0) + 1);
	}
	const fullDays = [...perDay.keys()].filter(
		(day) => day * DAY >= from && (day + 1) * DAY - 1 <= to
	);
	const dayCounts = sortedNumbers(fullDays.map((day) => perDay.get(day)));
	const windowDays = (to - from) / DAY;

	return {
		workflow: name,
		ticks,
		runs: inWindow.length,
		delivered_pct:
			ticks === 0 ? null : round((inWindow.length / ticks) * 100),
		slots_with_run_pct:
			ticks === 0 ? null : round((slotsWithRun / ticks) * 100),
		runs_per_day:
			windowDays > 0 ? round(inWindow.length / windowDays) : null,
		full_days: dayCounts.length,
		runs_per_full_day_median: round(percentile(dayCounts, 0.5)),
		gap_median_min: round(percentile(gaps, 0.5)),
		gap_p90_min: round(percentile(gaps, 0.9)),
		gap_max_min: round(gaps.length > 0 ? gaps[gaps.length - 1] : null),
		gaps_30min_or_more: gaps.filter((gap) => gap >= 30).length,
		delay_after_slot_p50_min: round(percentile(delays, 0.5)),
		delay_after_slot_p90_min: round(percentile(delays, 0.9)),
		start_lag_p50_s: round(percentile(lags, 0.5)),
	};
}

function yesNo(value) {
	if (value === null) {
		return 'n/a';
	}
	return value ? 'yes' : 'no';
}

// The decision rule of ADR 0005 D1. Each line is reported on its own. The owner decides.
function rules(byName) {
	const r5 = byName['pilot-5m'];
	const r15 = byName['pilot-15m'];
	const lines = [];
	if (r15) {
		lines.push({
			rule: 'Keep */15: delivered 70% or more of ticks and median gap 20 min or less',
			met: yesNo(
				r15.delivered_pct === null || r15.gap_median_min === null
					? null
					: r15.delivered_pct >= 70 && r15.gap_median_min <= 20
			),
		});
		lines.push({
			rule: 'Use */30 if */15 delivered under 50% of ticks (then check that its gaps are stable: p90 and max)',
			met: yesNo(
				r15.delivered_pct === null ? null : r15.delivered_pct < 50
			),
		});
	}
	if (r5 && r15) {
		lines.push({
			rule: 'Revise to */10 or */5: */5 delivers 1.5 times more runs per day than */15',
			met: yesNo(
				r5.runs_per_day === null || !r15.runs_per_day
					? null
					: r5.runs_per_day >= 1.5 * r15.runs_per_day
			),
		});
	}
	if (Object.keys(byName).length === 3) {
		const all = Object.values(byName);
		lines.push({
			rule: 'Stop and ask the owner: all three show about 5 runs per day (8 or fewer per day)',
			met: yesNo(
				all.every(
					(row) => row.runs_per_day !== null && row.runs_per_day <= 8
				)
			),
		});
	}
	return lines;
}

function markdown(results, ruleLines, window) {
	const columns = [
		['workflow', 'workflow'],
		['ticks', 'ticks'],
		['runs', 'runs'],
		['delivered %', 'delivered_pct'],
		['slots with a run %', 'slots_with_run_pct'],
		['runs per day', 'runs_per_day'],
		['full days', 'full_days'],
		['gap median (min)', 'gap_median_min'],
		['gap p90 (min)', 'gap_p90_min'],
		['gap max (min)', 'gap_max_min'],
		['gaps of 30 min or more', 'gaps_30min_or_more'],
		['delay after slot p50 (min)', 'delay_after_slot_p50_min'],
		['delay after slot p90 (min)', 'delay_after_slot_p90_min'],
		['start lag p50 (s)', 'start_lag_p50_s'],
	];
	const cell = (value) => (value === null ? '-' : String(value));
	const out = [];
	out.push(
		`Window: ${new Date(window.from).toISOString()} to ${new Date(window.to).toISOString()}`,
		''
	);
	out.push(`| ${columns.map(([title]) => title).join(' | ')} |`);
	out.push(`| ${columns.map(() => '---').join(' | ')} |`);
	for (const row of results) {
		out.push(`| ${columns.map(([, key]) => cell(row[key])).join(' | ')} |`);
	}
	out.push(
		'',
		'ADR 0005 D1 decision rule (each line on its own, nothing is chosen here):',
		''
	);
	for (const line of ruleLines) {
		out.push(`- ${line.rule}: ${line.met}`);
	}
	out.push(
		'',
		'Notes: "delivered %" is runs divided by ticks. "slots with a run %" counts a slot once. "delay after slot"',
		'is measured from the last cron slot before the run, so a run that is late by more than one slot looks',
		'early. Use the gaps for lateness. "start lag" is the time from run creation to the log step.'
	);
	return out.join('\n') + '\n';
}

function main() {
	const args = parseArgs(process.argv.slice(2));
	const loaded = args.files.map(readRuns);
	const all = loaded.flatMap((item) => item.runs);
	if (all.length === 0) {
		throw new Error('No scheduled runs found in the files.');
	}
	const window = {
		from: args.from ?? Math.min(...all.map((run) => run.time)),
		to: args.to ?? Math.max(...all.map((run) => run.time)),
	};
	const results = loaded.map((item) =>
		analyze(item.name, item.runs, window.from, window.to)
	);
	const byName = Object.fromEntries(
		results.map((row) => [row.workflow, row])
	);
	const ruleLines = rules(byName);
	if (args.json) {
		process.stdout.write(
			JSON.stringify({ window, results, rules: ruleLines }, null, 2) +
				'\n'
		);
		return;
	}
	process.stdout.write(markdown(results, ruleLines, window));
}

try {
	main();
} catch (error) {
	process.stderr.write(`${error.message}\n`);
	process.exitCode = 1;
}
