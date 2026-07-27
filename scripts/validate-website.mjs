import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const websiteRoot = path.join(repositoryRoot, "website");
const requiredFiles = [
  "index.html",
  "docs.html",
  "en/index.html",
  "en/docs.html",
  "assets/style.css",
  "assets/main.js",
];
const errors = [];

for (const relativePath of requiredFiles) {
  if (!existsSync(path.join(websiteRoot, relativePath))) {
    errors.push(`missing required website file: ${relativePath}`);
  }
}

const files = walkFiles(websiteRoot);
const htmlFiles = files.filter((file) => file.endsWith(".html"));
const anchorsByFile = new Map(
  htmlFiles.map((file) => [
    file,
    new Set(
      [...readFileSync(file, "utf8").matchAll(/\bid=["']([^"']+)["']/g)].map(
        (match) => match[1],
      ),
    ),
  ]),
);

for (const htmlFile of htmlFiles) {
  const source = readFileSync(htmlFile, "utf8");
  const relativeHtml = relativeToWebsite(htmlFile);

  for (const match of source.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    validateReference(match[1], htmlFile, relativeHtml);
  }

  for (const match of source.matchAll(
    /<a\b(?=[^>]*\btarget=["']_blank["'])[^>]*>/gi,
  )) {
    if (!/\brel=["'][^"']*\bnoopener\b[^"']*["']/i.test(match[0])) {
      errors.push(`${relativeHtml}: target="_blank" link is missing rel="noopener"`);
    }
  }
}

for (const cssFile of files.filter((file) => file.endsWith(".css"))) {
  const source = readFileSync(cssFile, "utf8");
  for (const match of source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)) {
    const reference = match[2].trim();
    if (isExternalReference(reference)) continue;
    validateFileReference(reference, cssFile, relativeToWebsite(cssFile));
  }
}

if (errors.length > 0) {
  console.error(`Website validation failed with ${errors.length} error(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Validated ${htmlFiles.length} HTML pages and ${files.length} website files with no broken local references.`,
);

function validateReference(reference, sourceFile, relativeSource) {
  if (isExternalReference(reference)) return;
  if (reference.startsWith("/")) {
    errors.push(
      `${relativeSource}: root-absolute reference breaks project Pages paths: ${reference}`,
    );
    return;
  }

  const [rawPath, rawHash] = reference.split("#", 2);
  const decodedPath = decodeReferencePath(rawPath.split("?", 1)[0], relativeSource);
  if (decodedPath === undefined) return;
  const targetFile = decodedPath
    ? path.resolve(path.dirname(sourceFile), decodedPath)
    : sourceFile;

  if (!isInsideWebsite(targetFile)) {
    errors.push(`${relativeSource}: local reference escapes website/: ${reference}`);
    return;
  }
  if (!existsSync(targetFile) || !statSync(targetFile).isFile()) {
    errors.push(`${relativeSource}: missing local target ${reference}`);
    return;
  }
  if (!rawHash) return;

  let hash;
  try {
    hash = decodeURIComponent(rawHash);
  } catch {
    errors.push(`${relativeSource}: invalid URL fragment encoding in ${reference}`);
    return;
  }
  const anchors = anchorsByFile.get(targetFile);
  if (!anchors) {
    errors.push(`${relativeSource}: fragment targets a non-HTML file: ${reference}`);
  } else if (!anchors.has(hash)) {
    errors.push(`${relativeSource}: missing fragment target ${reference}`);
  }
}

function validateFileReference(reference, sourceFile, relativeSource) {
  if (reference.startsWith("/")) {
    errors.push(
      `${relativeSource}: root-absolute asset breaks project Pages paths: ${reference}`,
    );
    return;
  }
  const rawPath = reference.split(/[?#]/, 1)[0];
  const decodedPath = decodeReferencePath(rawPath, relativeSource);
  if (decodedPath === undefined) return;
  const targetFile = path.resolve(path.dirname(sourceFile), decodedPath);
  if (!isInsideWebsite(targetFile)) {
    errors.push(`${relativeSource}: asset reference escapes website/: ${reference}`);
  } else if (!existsSync(targetFile) || !statSync(targetFile).isFile()) {
    errors.push(`${relativeSource}: missing asset ${reference}`);
  }
}

function decodeReferencePath(rawPath, relativeSource) {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    errors.push(`${relativeSource}: invalid URL path encoding in ${rawPath}`);
    return undefined;
  }
}

function isExternalReference(reference) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference);
}

function isInsideWebsite(target) {
  const relative = path.relative(websiteRoot, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function relativeToWebsite(file) {
  return path.relative(websiteRoot, file).split(path.sep).join("/");
}

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const target = path.join(directory, entry.name);
      return entry.isDirectory() ? walkFiles(target) : [target];
    });
}
