import crypto from 'node:crypto';
import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { audit } from '../audit.js';
import type { AuthUser } from '../auth.js';
import { one, pool, rows, tx, type Db } from '../db.js';
import { loadRefs, type Refs } from '../settings.js';
import { badRequest, clean, HEALTH, notFound, toCsv } from '../util.js';
import { applyStage, createVacancy, getMilestones, recomputeStage, updateVacancy } from './vacancies.js';

/** Target fields of the tracker, with header synonyms used to suggest a column mapping. */
export const IMPORT_FIELDS: { key: string; label: string; required?: boolean; recommended?: boolean; kind: 'text' | 'date' | 'ref' | 'enum'; syn: string[] }[] = [
  { key: 'title', label: 'Job title', required: true, kind: 'text', syn: ['job title', 'title', 'vacancy title', 'vacancy', 'position', 'role', 'job', 'job name', 'opening', 'position title', 'role title'] },
  { key: 'greenhouseJobId', label: 'Greenhouse job ID', kind: 'text', syn: ['greenhouse job id', 'greenhouse id', 'gh job id', 'gh id', 'job id', 'req id', 'requisition id', 'requisition', 'gh req'] },
  { key: 'country', label: 'Country (vacancy location)', recommended: true, kind: 'ref', syn: ['country', 'vacancy country', 'location country', 'location', 'job country'] },
  { key: 'city', label: 'City', kind: 'text', syn: ['city', 'office', 'site', 'town'] },
  { key: 'department', label: 'Department', kind: 'ref', syn: ['department', 'dept', 'function', 'business unit', 'division'] },
  { key: 'jobFamily', label: 'Job family', kind: 'text', syn: ['job family', 'family', 'job group'] },
  { key: 'vacancyType', label: 'Vacancy type', kind: 'text', syn: ['vacancy type', 'hire type', 'headcount type', 'type', 'new or replacement'] },
  { key: 'taTeam', label: 'Responsible TA team', kind: 'ref', syn: ['responsible ta team', 'ta team', 'responsible team', 'recruiting team', 'recruitment team'] },
  { key: 'recruiter', label: 'Recruiter', recommended: true, kind: 'ref', syn: ['recruiter', 'ta owner', 'ta partner', 'talent partner', 'responsible recruiter', 'recruiter name', 'ta', 'talent acquisition partner'] },
  { key: 'hiringManager', label: 'Hiring manager', recommended: true, kind: 'text', syn: ['hiring manager', 'hm', 'line manager', 'manager', 'hiring lead'] },
  { key: 'hiringManagerEmail', label: 'Hiring manager email', kind: 'text', syn: ['hiring manager email', 'hm email', 'manager email'] },
  { key: 'departmentOwner', label: 'Department owner', kind: 'text', syn: ['department owner', 'department head', 'dept head', 'business owner', 'head of department'] },
  { key: 'stakeholders', label: 'Additional stakeholders', kind: 'text', syn: ['stakeholders', 'additional stakeholders', 'interviewers', 'other stakeholders'] },
  { key: 'openingDate', label: 'Opening date', kind: 'date', syn: ['opening date', 'open date', 'opened', 'date opened', 'opened on', 'request date', 'start of search'] },
  { key: 'targetHireDate', label: 'Target hiring date', kind: 'date', syn: ['target hiring date', 'target hire date', 'target date', 'target start', 'target start date', 'desired start date', 'needed by'] },
  { key: 'priority', label: 'Priority', kind: 'enum', syn: ['priority', 'urgency', 'prio'] },
  { key: 'stage', label: 'Current recruitment stage', kind: 'text', syn: ['current recruitment stage', 'current stage', 'recruitment stage', 'stage', 'phase', 'pipeline stage', 'milestone'] },
  { key: 'status', label: 'Vacancy status', kind: 'enum', syn: ['vacancy status', 'status', 'state', 'job status'] },
  { key: 'health', label: 'Vacancy health', kind: 'enum', syn: ['vacancy health', 'health', 'rag', 'rag status', 'overall status', 'traffic light'] },
  { key: 'progressUpdate', label: 'Progress update', kind: 'text', syn: ['progress update', 'progress', 'latest update', 'status update', 'update', 'comments', 'comment', 'current situation'] },
  { key: 'lastUpdated', label: 'Last updated date', kind: 'date', syn: ['last updated', 'last update', 'last updated date', 'last update date', 'updated on', 'date of update'] },
  { key: 'latestAchievement', label: 'Latest achievement', kind: 'text', syn: ['latest achievement', 'achievement', 'last achievement', 'achievements'] },
  { key: 'nextAction', label: 'Next action', kind: 'text', syn: ['next action', 'next step', 'next steps', 'action', 'to do'] },
  { key: 'actionOwner', label: 'Action owner', kind: 'text', syn: ['action owner', 'next action owner', 'owner', 'responsible', 'action by', 'who'] },
  { key: 'actionDeadline', label: 'Action deadline', kind: 'date', syn: ['action deadline', 'deadline', 'due date', 'due', 'action due', 'next action date', 'by when'] },
  { key: 'currentBlocker', label: 'Current blocker', kind: 'text', syn: ['current blocker', 'blocker', 'blockers', 'issue', 'issues', 'risk', 'risks', 'challenges'] },
  { key: 'supportRequired', label: 'Support required', kind: 'text', syn: ['support required', 'support needed', 'help needed', 'escalation', 'support'] },
  { key: 'internalNotes', label: 'Internal notes', kind: 'text', syn: ['internal notes', 'notes', 'remarks', 'note'] },
  { key: 'closureDate', label: 'Closure date', kind: 'date', syn: ['closure date', 'closed date', 'date closed', 'hire date', 'filled date', 'closed on'] },
];

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const MAX_ROWS = 5000;

export interface ParsedSheet { name: string; headerRow: number; columns: string[]; rows: (string | number | null)[][]; truncated: boolean }

function cellValue(v: any): string | number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r: any) => r.text).join('').trim() || null;
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    if ('error' in v) return null;
    return null;
  }
  if (typeof v === 'string') return v.trim() === '' ? null : v.trim();
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return v;
}

/** The header is the row (within the first 20) whose cells best match known column names. */
function toSheet(name: string, grid: (string | number | null)[][]): ParsedSheet | null {
  const known = new Set(IMPORT_FIELDS.flatMap((f) => f.syn.map(norm)));
  let best = -1;
  let bestScore = 0;
  grid.slice(0, 20).forEach((row, i) => {
    const filled = row.filter((c) => c !== null);
    if (filled.length < 2) return;
    const score = filled.filter((c) => known.has(norm(c))).length * 10 + filled.filter((c) => typeof c === 'string').length;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  if (best < 0) return null;
  const width = Math.max(...grid.map((r) => r.length));
  const columns = Array.from({ length: width }, (_, i) => String(grid[best][i] ?? '').trim() || `Column ${i + 1}`);
  const body = grid.slice(best + 1).filter((r) => r.some((c) => c !== null)).map((r) => Array.from({ length: width }, (_, i) => r[i] ?? null));
  const keep = columns.map((_, i) => !columns[i].startsWith('Column ') || body.some((r) => r[i] !== null));
  return {
    name, headerRow: best + 1, columns: columns.filter((_, i) => keep[i]),
    rows: body.slice(0, MAX_ROWS).map((r) => r.filter((_, i) => keep[i])), truncated: body.length > MAX_ROWS,
  };
}

export async function parseFile(buffer: Buffer, filename: string): Promise<ParsedSheet[]> {
  const ext = filename.toLowerCase().split('.').pop();
  const sheets: ParsedSheet[] = [];
  if (ext === 'csv' || ext === 'txt') {
    const text = buffer.toString('utf8').replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0] ?? '';
    const delimiter = (first.match(/;/g)?.length ?? 0) > (first.match(/,/g)?.length ?? 0) ? ';' : first.includes('\t') && !first.includes(',') ? '\t' : ',';
    const grid = (parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: true, relax_quotes: true }) as string[][])
      .map((r) => r.map((c) => (c.trim() === '' ? null : c.trim())));
    const s = toSheet('CSV', grid);
    if (s) sheets.push(s);
  } else if (ext === 'xlsx' || ext === 'xlsm') {
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer as any);
    } catch {
      throw badRequest('The file could not be read as an Excel workbook. Save it as .xlsx and try again.');
    }
    wb.eachSheet((ws) => {
      const grid: (string | number | null)[][] = [];
      ws.eachRow({ includeEmpty: true }, (row) => {
        const vals = (row.values as any[]).slice(1);
        grid.push(Array.from({ length: vals.length }, (_, i) => cellValue(vals[i])));
      });
      const s = toSheet(ws.name, grid);
      if (s) sheets.push(s);
    });
  } else if (ext === 'xls') {
    throw badRequest('Legacy .xls files are not supported. Open the file in Excel, choose “Save as → Excel Workbook (.xlsx)” and upload that.');
  } else {
    throw badRequest('Upload an Excel workbook (.xlsx) or a CSV file.');
  }
  if (!sheets.length) throw badRequest('No sheet with a recognisable header row and data was found in this file.');
  return sheets;
}

/** Best-guess mapping field → column index, with a confidence the UI shows so users know what to double-check. */
export function suggestMapping(columns: string[]): Record<string, { column: number | null; confidence: 'high' | 'medium' | 'none' }> {
  const candidates: { field: string; column: number; score: number }[] = [];
  columns.forEach((col, i) => {
    const h = norm(col);
    if (!h) return;
    for (const f of IMPORT_FIELDS) {
      let score = 0;
      f.syn.forEach((s, rank) => {
        const n = norm(s);
        if (h === n) score = Math.max(score, 100 - rank);
        else if (n.length >= 4 && (h.includes(n) || (h.length >= 4 && n.includes(h)))) score = Math.max(score, 50 - rank + Math.min(n.length, 20));
      });
      if (score) candidates.push({ field: f.key, column: i, score });
    }
  });
  candidates.sort((a, b) => b.score - a.score);
  const out: Record<string, { column: number | null; confidence: 'high' | 'medium' | 'none' }> = {};
  const used = new Set<number>();
  for (const c of candidates) {
    if (out[c.field] || used.has(c.column)) continue;
    out[c.field] = { column: c.column, confidence: c.score >= 80 ? 'high' : 'medium' };
    used.add(c.column);
  }
  for (const f of IMPORT_FIELDS) out[f.key] ??= { column: null, confidence: 'none' };
  return out;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseDate(v: unknown, order: 'dmy' | 'mdy' = 'dmy'): string | null | undefined {
  if (v === null || v === undefined || v === '') return null;
  const iso = (y: number, m: number, d: number) => {
    if (y < 100) y += 2000;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y > 1990 && y < 2100 ? dt.toISOString().slice(0, 10) : undefined;
  };
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400000)).toISOString().slice(0, 10); // Excel serial date
    return undefined;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return iso(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    const dayFirst = a > 12 ? true : b > 12 ? false : order === 'dmy';
    return dayFirst ? iso(+m[3], b, a) : iso(+m[3], a, b);
  }
  m = s.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,})[\s,-]+(\d{2,4})$/);
  if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return iso(+m[3], MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
  return undefined; // present but unreadable
}

const HEALTH_WORDS: [RegExp, keyof typeof HEALTH][] = [
  [/block|stuck|red\b/, 'blocked'], [/await|waiting|pending feedback|feedback/, 'awaiting_feedback'],
  [/attention|at risk|amber|yellow|delay|behind|concern/, 'needs_attention'], [/on track|green|good|healthy|progressing|as planned/, 'on_track'],
];
const STATUS_WORDS: [RegExp, string][] = [
  [/hold|paused|frozen|freeze/, 'on_hold'], [/cancel|withdrawn|closed without/, 'cancelled'],
  [/fill|hired|closed|offer accepted|completed/, 'filled'], [/open|active|in progress|ongoing|live|approved|new/, 'active'],
];
const PRIORITY_WORDS: [RegExp, string][] = [[/crit|urgent|p0|p1|highest/, 'critical'], [/high|p2/, 'high'], [/med|normal|p3|standard/, 'medium'], [/low|p4/, 'low']];

export interface Issue { level: 'error' | 'warning' | 'info'; field?: string; message: string }
export interface PreviewRow {
  rowNumber: number;                       // row number in the original sheet
  values: Record<string, any>;             // normalised values ready for import
  display: Record<string, string | null>;  // human-readable values for the preview table
  issues: Issue[];
  duplicate: null | { type: 'greenhouse_id' | 'title_location' | 'within_file'; vacancyId?: number; label: string; allowNew: boolean; allowUpdate: boolean };
  status: 'ready' | 'duplicate' | 'error';
  defaultDecision: 'import' | 'skip';
}
export interface ImportOptions { createMissingRefs?: boolean; dateOrder?: 'dmy' | 'mdy' }

export async function buildPreview(db: Db, sheet: ParsedSheet, mapping: Record<string, number | null>, options: ImportOptions = {}) {
  const refs = await loadRefs(db);
  const existing = await rows<any>(db, `SELECT v.id, v.title, v.greenhouse_job_id, c.name AS country FROM vacancies v
                                         LEFT JOIN countries c ON c.id = v.country_id WHERE v.archived_at IS NULL`);
  const defaultTpl = refs.templates.find((t: any) => t.isDefault) ?? refs.templates[0];
  const newRefs = { countries: new Set<string>(), departments: new Set<string>(), teams: new Set<string>() };
  const seen = new Map<string, number>();
  const out: PreviewRow[] = [];
  const get = (row: (string | number | null)[], key: string) => (mapping[key] === null || mapping[key] === undefined ? null : row[mapping[key]!]);

  sheet.rows.forEach((row, i) => {
    const issues: Issue[] = [];
    const values: Record<string, any> = {};
    const display: Record<string, string | null> = {};
    const text = (key: string) => { const v = clean(get(row, key)); if (v) { values[key] = v; display[key] = v; } return v; };

    const title = text('title');
    if (!title) issues.push({ level: 'error', field: 'title', message: 'Job title is missing — this row cannot be imported.' });
    for (const k of ['greenhouseJobId', 'city', 'jobFamily', 'vacancyType', 'hiringManager', 'hiringManagerEmail', 'departmentOwner', 'stakeholders',
      'progressUpdate', 'latestAchievement', 'nextAction', 'actionOwner', 'currentBlocker', 'supportRequired', 'internalNotes']) text(k);
    if (values.greenhouseJobId) values.greenhouseJobId = String(values.greenhouseJobId).replace(/\.0$/, '');

    for (const k of ['openingDate', 'targetHireDate', 'actionDeadline', 'closureDate', 'lastUpdated']) {
      const raw = get(row, k);
      const d = parseDate(raw, options.dateOrder);
      if (d) { values[k] = d; display[k] = d; } else if (d === undefined) {
        issues.push({ level: 'warning', field: k, message: `“${raw}” is not a recognisable date; ${IMPORT_FIELDS.find((f) => f.key === k)!.label.toLowerCase()} will be left empty.` });
      }
    }
    if (values.openingDate && values.targetHireDate && values.targetHireDate < values.openingDate) {
      issues.push({ level: 'warning', field: 'targetHireDate', message: 'Target hiring date is before the opening date; it will be left empty.' });
      delete values.targetHireDate; delete display.targetHireDate;
    }

    const ref = (key: 'country' | 'department' | 'taTeam', list: any[], bucket: Set<string>, idKey: string, label: string) => {
      const raw = clean(get(row, key));
      if (!raw) return;
      const n = raw.toLowerCase();
      const hit = list.find((x) => x.name.toLowerCase() === n || (key === 'country' && x.isoCode?.toLowerCase() === n));
      if (hit) { values[idKey] = hit.id; display[key] = hit.name; return; }
      display[key] = raw;
      if (options.createMissingRefs) { bucket.add(raw); values[`${key}New`] = raw; issues.push({ level: 'info', field: key, message: `${label} “${raw}” does not exist yet and will be created.` }); }
      else issues.push({ level: 'warning', field: key, message: `${label} “${raw}” is not in the reference list; the field will be left empty (or enable “create missing values”).` });
    };
    ref('country', refs.countries, newRefs.countries, 'countryId', 'Country');
    ref('department', refs.departments, newRefs.departments, 'departmentId', 'Department');
    ref('taTeam', refs.teams, newRefs.teams, 'taTeamId', 'TA team');

    const rec = clean(get(row, 'recruiter'));
    if (rec) {
      const n = rec.toLowerCase();
      const pool2 = refs.users.filter((u: any) => u.isActive);
      const hits = pool2.filter((u: any) => u.name.toLowerCase() === n || u.email.toLowerCase() === n);
      const loose = hits.length ? hits : pool2.filter((u: any) => u.name.toLowerCase().split(' ')[0] === n || u.name.toLowerCase().startsWith(`${n} `));
      if (loose.length === 1) { values.recruiterId = loose[0].id; display.recruiter = loose[0].name; }
      else { display.recruiter = rec; issues.push({ level: 'warning', field: 'recruiter', message: `Recruiter “${rec}” ${loose.length > 1 ? 'matches more than one user' : 'is not a user in this application'}; the vacancy will be imported unassigned.` }); }
    }

    const pr = clean(get(row, 'priority'));
    if (pr) {
      const hit = PRIORITY_WORDS.find(([re]) => re.test(pr.toLowerCase()));
      if (hit) { values.priority = hit[1]; display.priority = hit[1]; } else issues.push({ level: 'warning', field: 'priority', message: `Priority “${pr}” was not recognised; “medium” will be used.` });
    }
    const health = (raw: string) => HEALTH_WORDS.find(([re]) => re.test(raw.toLowerCase()))?.[1];
    const st = clean(get(row, 'status'));
    if (st) {
      const n = st.toLowerCase();
      const direct = refs.statuses.find((s: any) => s.label.toLowerCase() === n || s.key === n);
      const cat = direct?.category ?? STATUS_WORDS.find(([re]) => re.test(n))?.[1];
      const status = direct ?? refs.statuses.find((s: any) => s.category === cat && s.isActive);
      if (status) { values.statusId = status.id; display.status = status.label; }
      else if (health(st)) { values.health = health(st); issues.push({ level: 'info', field: 'status', message: `Status “${st}” describes health, so it was read as vacancy health; status is set to Open.` }); }
      else issues.push({ level: 'warning', field: 'status', message: `Status “${st}” was not recognised; “Open” will be used.` });
    }
    const he = clean(get(row, 'health'));
    if (he) {
      const h = health(he);
      if (h) values.health = h; else issues.push({ level: 'warning', field: 'health', message: `Health “${he}” was not recognised; “On track” will be used.` });
    }
    if (values.health) display.health = HEALTH[values.health as keyof typeof HEALTH];

    const stage = clean(get(row, 'stage'));
    if (stage && defaultTpl) {
      const n = norm(stage);
      const hit = defaultTpl.items.find((m: any) => norm(m.name) === n) ?? defaultTpl.items.find((m: any) => n.length >= 4 && (norm(m.name).includes(n) || n.includes(norm(m.name))));
      values.stage = hit ? hit.name : stage;
      display.stage = values.stage;
      if (!hit) { values.stageCustom = true; issues.push({ level: 'info', field: 'stage', message: `Stage “${stage}” is not in the “${defaultTpl.name}” milestones; it will be added to this vacancy as a custom milestone.` }); }
    }

    const missing = IMPORT_FIELDS.filter((f) => f.recommended && !display[f.key]).map((f) => f.label.toLowerCase());
    if (title && missing.length) issues.push({ level: 'warning', message: `Missing recommended information: ${missing.join(', ')}.` });

    // Duplicate detection: Greenhouse ID first, then title + country; against the tracker and within the file.
    let duplicate: PreviewRow['duplicate'] = null;
    if (title) {
      const gh = values.greenhouseJobId as string | undefined;
      const keyGh = gh ? `gh:${gh}` : null;
      const keyTitle = `t:${title.toLowerCase()}|${(display.country ?? '').toLowerCase()}`;
      const exGh = gh ? existing.find((e) => e.greenhouseJobId === gh) : undefined;
      const exTitle = existing.find((e) => e.title.toLowerCase() === title.toLowerCase() && (e.country ?? '').toLowerCase() === (display.country ?? '').toLowerCase());
      if (exGh) duplicate = { type: 'greenhouse_id', vacancyId: exGh.id, label: `Greenhouse job ID ${gh} is already in the tracker as “${exGh.title}”.`, allowNew: false, allowUpdate: true };
      else if (keyGh && seen.has(keyGh)) duplicate = { type: 'within_file', label: `Same Greenhouse job ID as row ${seen.get(keyGh)} of this file.`, allowNew: false, allowUpdate: false };
      else if (exTitle) duplicate = { type: 'title_location', vacancyId: exTitle.id, label: `A vacancy with the same title and country is already in the tracker (“${exTitle.title}”${exTitle.country ? `, ${exTitle.country}` : ''}).`, allowNew: true, allowUpdate: true };
      else if (seen.has(keyTitle)) duplicate = { type: 'within_file', label: `Same title and country as row ${seen.get(keyTitle)} of this file.`, allowNew: true, allowUpdate: false };
      if (keyGh && !seen.has(keyGh)) seen.set(keyGh, sheet.headerRow + 1 + i);
      if (!seen.has(keyTitle)) seen.set(keyTitle, sheet.headerRow + 1 + i);
    }
    const hasError = issues.some((x) => x.level === 'error');
    out.push({ rowNumber: sheet.headerRow + 1 + i, values, display, issues, duplicate, status: hasError ? 'error' : duplicate ? 'duplicate' : 'ready',
      defaultDecision: hasError || duplicate ? 'skip' : 'import' });
  });

  const count = (s: string) => out.filter((r) => r.status === s).length;
  return {
    rows: out,
    summary: { total: out.length, ready: count('ready'), duplicates: count('duplicate'), errors: count('error'),
      withWarnings: out.filter((r) => r.issues.some((x) => x.level === 'warning')).length, truncated: sheet.truncated },
    newReferenceValues: { countries: [...newRefs.countries], departments: [...newRefs.departments], teams: [...newRefs.teams] },
    unmappedColumns: sheet.columns.filter((_, i) => !Object.values(mapping).includes(i)),
  };
}

export async function createBatch(user: AuthUser, file: { originalname: string; size: number; buffer: Buffer }) {
  const sheets = await parseFile(file.buffer, file.originalname);
  const sha = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const prior = await one<any>(pool, `SELECT id, imported_at FROM import_batches WHERE file_sha256 = $1 AND status = 'imported' ORDER BY imported_at DESC LIMIT 1`, [sha]);
  const row = await one<{ id: number }>(pool,
    `INSERT INTO import_batches (filename, file_size, file_sha256, uploaded_by, sheets) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [file.originalname, file.size, sha, user.id, JSON.stringify(sheets)]);
  await audit(pool, { id: user.id, name: user.name }, { entityType: 'import', entityId: row!.id, action: 'uploaded',
    summary: `Uploaded ${file.originalname} (${sheets.length} sheet${sheets.length === 1 ? '' : 's'}, ${sheets.reduce((s, x) => s + x.rows.length, 0)} data rows)` });
  return {
    id: row!.id, filename: file.originalname, previouslyImportedAt: prior?.importedAt ?? null,
    sheets: sheets.map((s) => ({ name: s.name, headerRow: s.headerRow, columns: s.columns, rowCount: s.rows.length, truncated: s.truncated,
      sample: s.rows.slice(0, 5), suggestedMapping: suggestMapping(s.columns) })),
    fields: IMPORT_FIELDS.map(({ key, label, required, recommended, kind }) => ({ key, label, required: !!required, recommended: !!recommended, kind })),
  };
}

async function loadBatch(db: Db, id: number) {
  const b = await one<any>(db, 'SELECT * FROM import_batches WHERE id = $1', [id]);
  if (!b) throw notFound('Import batch');
  return b;
}
function pickSheet(b: any, sheetName: string): ParsedSheet {
  const s = (b.sheets as ParsedSheet[]).find((x) => x.name === sheetName);
  if (!s) throw badRequest('That sheet is not part of the uploaded file');
  return s;
}
const cleanMapping = (sheet: ParsedSheet, mapping: Record<string, unknown>) => {
  const out: Record<string, number | null> = {};
  for (const f of IMPORT_FIELDS) {
    const v = mapping?.[f.key];
    out[f.key] = typeof v === 'number' && v >= 0 && v < sheet.columns.length ? v : null;
  }
  if (out.title === null) throw badRequest('Map a column to “Job title” before continuing — it is the only required field.');
  return out;
};

export async function previewBatch(id: number, body: { sheetName: string; mapping: Record<string, unknown>; options?: ImportOptions }) {
  const b = await loadBatch(pool, id);
  if (b.status !== 'uploaded') throw badRequest('This batch has already been imported or discarded.');
  const sheet = pickSheet(b, body.sheetName);
  return buildPreview(pool, sheet, cleanMapping(sheet, body.mapping), body.options);
}

/**
 * Imports the rows the user approved. Existing records are only touched when the user
 * chose "update" for that specific row; the default for every duplicate is to skip it.
 */
export async function commitBatch(user: AuthUser, id: number, body: { sheetName: string; mapping: Record<string, unknown>; options?: ImportOptions; decisions: Record<string, 'import' | 'skip' | 'update'> }) {
  const actorInfo = { id: user.id, name: user.name };
  return tx(async (db) => {
    const b = await one<any>(db, 'SELECT * FROM import_batches WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Import batch');
    if (b.status !== 'uploaded') throw badRequest('This batch has already been imported or discarded.');
    const sheet = pickSheet(b, body.sheetName);
    const mapping = cleanMapping(sheet, body.mapping);
    const preview = await buildPreview(db, sheet, mapping, body.options);
    const created: Record<string, string[]> = { countries: [], departments: [], teams: [] };
    const totals = { rows: preview.rows.length, created: 0, updated: 0, skippedDuplicate: 0, skippedError: 0, skippedByUser: 0 };

    const refId = async (table: 'countries' | 'departments' | 'ta_teams', name: string, bucket: string[]) => {
      const ex = await one<{ id: number }>(db, `SELECT id FROM ${table} WHERE lower(name) = lower($1)`, [name]);
      if (ex) return ex.id;
      const r = await one<{ id: number }>(db, `INSERT INTO ${table} (name) VALUES ($1) RETURNING id`, [name]);
      bucket.push(name);
      await audit(db, actorInfo, { entityType: 'reference', entityId: r!.id, action: 'created', summary: `Created ${table.replace('ta_', 'TA ').replace(/s$/, '').replace('countrie', 'country')} “${name}” during import #${id}` });
      return r!.id;
    };

    for (const row of preview.rows) {
      const decision = body.decisions?.[String(row.rowNumber)] ?? row.defaultDecision;
      const messages = [...row.issues];
      const record = async (outcome: string, vacancyId: number | null = null) => {
        await db.query('INSERT INTO import_rows (batch_id, row_number, raw, outcome, vacancy_id, messages) VALUES ($1,$2,$3,$4,$5,$6)',
          [id, row.rowNumber, JSON.stringify(row.display), outcome, vacancyId, JSON.stringify(messages)]);
      };
      if (row.status === 'error') { totals.skippedError += 1; await record('skipped_error'); continue; }
      if (row.duplicate) messages.push({ level: 'info', message: `Duplicate: ${row.duplicate.label}` });
      if (decision === 'skip') {
        if (row.duplicate) { totals.skippedDuplicate += 1; await record('skipped_duplicate', row.duplicate.vacancyId ?? null); }
        else { totals.skippedByUser += 1; await record('skipped_by_user'); }
        continue;
      }
      if (row.duplicate && decision === 'import' && !row.duplicate.allowNew) {
        messages.push({ level: 'error', message: 'Cannot import as a new record because the Greenhouse job ID must be unique.' });
        totals.skippedDuplicate += 1; await record('skipped_duplicate', row.duplicate.vacancyId ?? null); continue;
      }
      if (decision === 'update' && !(row.duplicate?.allowUpdate && row.duplicate.vacancyId)) {
        messages.push({ level: 'error', message: 'There is no existing record to update for this row.' });
        totals.skippedError += 1; await record('skipped_error'); continue;
      }

      await db.query('SAVEPOINT import_row');
      try {
        const v = { ...row.values };
        if (v.countryNew) v.countryId = await refId('countries', v.countryNew, created.countries);
        if (v.departmentNew) v.departmentId = await refId('departments', v.departmentNew, created.departments);
        if (v.taTeamNew) v.taTeamId = await refId('ta_teams', v.taTeamNew, created.teams);
        const payload: Record<string, unknown> = {};
        for (const k of ['title', 'greenhouseJobId', 'countryId', 'city', 'departmentId', 'jobFamily', 'vacancyType', 'taTeamId', 'recruiterId',
          'hiringManager', 'hiringManagerEmail', 'departmentOwner', 'stakeholders', 'openingDate', 'targetHireDate', 'priority', 'statusId', 'health',
          'progressUpdate', 'latestAchievement', 'nextAction', 'actionOwner', 'actionDeadline', 'currentBlocker', 'supportRequired', 'internalNotes', 'closureDate']) {
          if (v[k] !== undefined && v[k] !== null) payload[k] = v[k];
        }
        let vacancyId: number;
        if (decision === 'update') {
          vacancyId = row.duplicate!.vacancyId!;
          await updateVacancy(db, user, vacancyId, payload); // field-level before/after is written to the audit log
          messages.push({ level: 'info', message: 'Existing record updated at the user’s explicit request; only non-empty imported values were applied.' });
          totals.updated += 1;
        } else {
          vacancyId = await createVacancy(db, null, actorInfo, payload, { source: `import #${id}, row ${row.rowNumber}` });
          totals.created += 1;
        }
        if (v.stage) {
          let ms = await getMilestones(vacancyId, db);
          let target = ms.find((m) => m.name.toLowerCase() === String(v.stage).toLowerCase());
          if (!target) {
            await db.query('UPDATE vacancy_milestones SET position = position + 1 WHERE vacancy_id = $1', [vacancyId]);
            await db.query(`INSERT INTO vacancy_milestones (vacancy_id, name, position, status) VALUES ($1,$2,1,'pending')`, [vacancyId, v.stage]);
            ms = await getMilestones(vacancyId, db);
            target = ms.find((m) => m.name === v.stage);
          }
          const filled = !!(await one(db, `SELECT 1 AS x FROM vacancies v JOIN vacancy_statuses s ON s.id = v.status_id WHERE v.id = $1 AND s.category = 'filled'`, [vacancyId]));
          await applyStage(db, vacancyId, target!.id, filled);
          await recomputeStage(db, vacancyId);
        }
        if (v.lastUpdated) await db.query(`UPDATE vacancies SET last_update_at = $2::date + time '12:00' WHERE id = $1`, [vacancyId, v.lastUpdated]);
        const cur = await one<any>(db, `SELECT v.*, s.label AS status_label, s.category AS status_category FROM vacancies v JOIN vacancy_statuses s ON s.id = v.status_id WHERE v.id = $1`, [vacancyId]);
        await db.query(
          `INSERT INTO vacancy_updates (vacancy_id, user_id, created_at, summary, achievement, stage, status_label, status_category, health, next_action, action_owner, action_deadline, blocker, support_required, source)
           VALUES ($1,$2,COALESCE($3::date + time '12:00', now()),$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'import')`,
          [vacancyId, user.id, v.lastUpdated ?? null, v.progressUpdate ?? `Imported from ${b.filename} (row ${row.rowNumber}).`, v.latestAchievement ?? null,
            cur.currentStage, cur.statusLabel, cur.statusCategory, cur.health, cur.nextAction, cur.actionOwner, cur.actionDeadline, cur.currentBlocker, cur.supportRequired]);
        await db.query('RELEASE SAVEPOINT import_row');
        await record(decision === 'update' ? 'updated' : 'created', vacancyId);
      } catch (err) {
        await db.query('ROLLBACK TO SAVEPOINT import_row');
        messages.push({ level: 'error', message: (err as Error).message });
        totals.skippedError += 1;
        await record('skipped_error');
      }
    }
    // Totals are recounted from what was actually written, so a failed row can never be reported as imported.
    const counted = await rows<{ outcome: string; n: number }>(db, 'SELECT outcome, count(*) AS n FROM import_rows WHERE batch_id = $1 GROUP BY outcome', [id]);
    const n = (o: string) => counted.find((c) => c.outcome === o)?.n ?? 0;
    Object.assign(totals, { created: n('created'), updated: n('updated'), skippedDuplicate: n('skipped_duplicate'), skippedError: n('skipped_error'), skippedByUser: n('skipped_by_user') });
    const report = { totals, createdReferenceValues: created, sheet: sheet.name, mapping: Object.fromEntries(Object.entries(mapping).filter(([, c]) => c !== null).map(([k, c]) => [k, sheet.columns[c!]])),
      unmappedColumns: preview.unmappedColumns, options: body.options ?? {} };
    await db.query(`UPDATE import_batches SET status = 'imported', sheet_name = $2, mapping = $3, options = $4, report = $5, imported_at = now(), imported_by = $6,
                      sheets = '[]'::jsonb WHERE id = $1`,
      [id, sheet.name, JSON.stringify(mapping), JSON.stringify(body.options ?? {}), JSON.stringify(report), user.id]);
    await audit(db, actorInfo, { entityType: 'import', entityId: id, action: 'imported',
      summary: `Imported ${b.filename}: ${totals.created} created, ${totals.updated} updated, ${totals.skippedDuplicate} duplicates skipped, ${totals.skippedError} rows with errors, ${totals.skippedByUser} skipped by user`, changes: report });
    return { id, ...report };
  });
}

export async function batchReport(id: number) {
  const b = await one<any>(pool, `SELECT b.id, b.filename, b.file_size, b.status, b.uploaded_at, b.imported_at, b.report, u.name AS uploaded_by, i.name AS imported_by
                                     FROM import_batches b LEFT JOIN users u ON u.id = b.uploaded_by LEFT JOIN users i ON i.id = b.imported_by WHERE b.id = $1`, [id]);
  if (!b) throw notFound('Import batch');
  const r = await rows<any>(pool, `SELECT r.row_number, r.raw, r.outcome, r.vacancy_id, r.messages, v.title AS vacancy_title FROM import_rows r
                                     LEFT JOIN vacancies v ON v.id = r.vacancy_id WHERE r.batch_id = $1 ORDER BY r.row_number`, [id]);
  return { ...b, rows: r };
}

export async function batchReportCsv(id: number): Promise<{ filename: string; csv: string }> {
  const b = await batchReport(id);
  const label: Record<string, string> = { created: 'Created', updated: 'Updated existing record', skipped_duplicate: 'Skipped — duplicate',
    skipped_error: 'Skipped — error', skipped_by_user: 'Skipped by user' };
  const data = b.rows.map((r: any) => [r.rowNumber, label[r.outcome] ?? r.outcome, r.raw?.title ?? '', r.raw?.greenhouseJobId ?? '', r.raw?.country ?? '',
    r.vacancyId ?? '', (r.messages ?? []).map((m: Issue) => `[${m.level}] ${m.message}`).join(' | ')]);
  return { filename: `import-${id}-validation-report.csv`, csv: toCsv(['Source row', 'Outcome', 'Job title', 'Greenhouse job ID', 'Country', 'Tracker vacancy ID', 'Messages'], data) };
}
