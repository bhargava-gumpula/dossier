// Turn an uploaded file into text the agent can read.
//
// The profile is the source of truth - tailor_resume reorders it and the PDF is
// generated from it - so an uploaded resume has to become profile data, or
// tailoring silently stops working on real candidates.
//
// Nothing on this machine could read a PDF: no pdftotext, mutool or qpdf, and no
// pypdf/pdfplumber/fitz. Hence the one dependency. macOS textutil handles the
// word-processor formats and is already present.

import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { extname, basename } from 'node:path';

const require = createRequire(import.meta.url);

const TEXTUTIL_FORMATS = new Set(['.docx', '.doc', '.rtf', '.odt', '.html', '.htm']);
const PLAIN_FORMATS = new Set(['.txt', '.md', '.markdown', '.text']);

export async function extractText(filePath) {
  if (!existsSync(filePath)) throw new Error(`no file at ${filePath}`);
  const ext = extname(filePath).toLowerCase();

  if (PLAIN_FORMATS.has(ext)) {
    return { text: readFileSync(filePath, 'utf8'), how: 'read directly' };
  }

  if (ext === '.pdf') {
    const { PDFParse } = require('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(readFileSync(filePath)) });
    const result = await parser.getText();
    return { text: result.text ?? '', how: 'pdf-parse', pages: result.pages?.length };
  }

  if (TEXTUTIL_FORMATS.has(ext)) {
    // textutil ships with macOS and handles the word-processor formats.
    const out = execFileSync('textutil', ['-convert', 'txt', '-stdout', filePath], {
      encoding: 'utf8', maxBuffer: 8e6,
    });
    return { text: out, how: 'textutil' };
  }

  throw new Error(`unsupported file type: ${ext || '(none)'}`);
}

// Store the uploaded resume outside the repo. private/ is gitignored, and
// DOSSIER_RESUME already overrides the fixture path, so a real candidate's
// document never lands in version control (hackathon rule 7).
export function storeUpload(rootDir, filename, buffer) {
  const dir = `${rootDir}/private/uploads`;
  mkdirSync(dir, { recursive: true });
  const safe = basename(filename).replace(/[^\w.\-]/g, '_').slice(0, 80) || 'upload';
  const path = `${dir}/${Date.now().toString(36)}-${safe}`;
  writeFileSync(path, buffer);
  return path;
}

// A light structural read, so the agent gets a head start and the human can see
// immediately that the upload worked. The agent still decides what becomes
// profile data - this only surfaces candidates.
export function skimResume(text) {
  const emails = [...new Set(text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? [])];
  const phones = [...new Set(text.match(/(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [])];
  const links = [...new Set(text.match(/https?:\/\/[^\s)]+/g) ?? [])];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  const SECTION = /^(experience|work experience|employment|education|skills|projects|summary)\b/i;
  const sections = {};
  let current = 'header';
  for (const line of lines) {
    if (SECTION.test(line)) { current = line.toLowerCase().split(/\s+/)[0]; sections[current] = []; continue; }
    (sections[current] ??= []).push(line);
  }

  return {
    chars: text.length,
    lines: lines.length,
    emails, phones, links,
    sectionsFound: Object.keys(sections).filter((k) => k !== 'header'),
    likelyName: lines[0]?.slice(0, 60) ?? null,
  };
}
