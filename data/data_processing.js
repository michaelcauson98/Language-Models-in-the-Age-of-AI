import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Matrix, EigenvalueDecomposition } from "ml-matrix";
import readline from "node:readline";
import { createReadStream, createWriteStream } from "node:fs";
import { Filter } from "bad-words";

const INPUT_PATH = "vectors.txt";
const PCA_TEXT_OUTPUT = "vectors_pca.txt";
const META_OUTPUT = "word2vec_meta.json";
const WORDS_OUTPUT = "word2vec_words.json";
const VECTORS_OUTPUT = "word2vec_vectors.bin";
const PCA_OUTPUT = "word2vec_pca.bin";
const COMPONENTS = 5;
const profanityFilter = new Filter();

function isBlockedWord(word) {
  const raw = String(word || "").trim();
  if (!raw) return false;

  const normalized = raw
    .normalize("NFC")
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "");

  return Boolean(normalized) && profanityFilter.isProfane(normalized);
}

async function* vectorRows(filePath) {
  const stream = createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let headerSeen = false;
  let dimension = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (!headerSeen) {
      const [, dimToken] = trimmed.split(/\s+/);
      dimension = Number(dimToken);
      if (!Number.isFinite(dimension)) {
        throw new Error("Invalid vectors.txt header.");
      }
      headerSeen = true;
      continue;
    }

    const firstSpace = trimmed.indexOf(" ");
    if (firstSpace < 0) continue;

    const word = trimmed.slice(0, firstSpace);
    if (word === "</s>") continue;
    if (isBlockedWord(word)) continue;

    const tokens = trimmed.slice(firstSpace + 1).trim().split(/\s+/);
    if (tokens.length < dimension) continue;

    const values = new Float64Array(dimension);
    for (let i = 0; i < dimension; i++) values[i] = Number(tokens[i]);
    yield { word, values, dimension };
  }
}

async function loadDataset(filePath) {
  const words = [];
  const rawRows = [];
  let dimension = 0;

  for await (const row of vectorRows(filePath)) {
    if (!dimension) dimension = row.dimension;
    words.push(row.word);
    rawRows.push(Array.from(row.values));
  }

  if (!dimension || rawRows.length === 0) {
    throw new Error("No vectors found.");
  }

  return {
    words,
    matrix: new Matrix(rawRows),
    count: rawRows.length,
    dimension
  };
}

function computeMeanVector(matrix) {
  const mean = new Float64Array(matrix.columns);
  for (let row = 0; row < matrix.rows; row++) {
    for (let column = 0; column < matrix.columns; column++) {
      mean[column] += matrix.get(row, column);
    }
  }
  for (let column = 0; column < matrix.columns; column++) {
    mean[column] /= matrix.rows;
  }
  return mean;
}

function centerMatrix(matrix, mean) {
  const centered = Matrix.zeros(matrix.rows, matrix.columns);
  for (let row = 0; row < matrix.rows; row++) {
    for (let column = 0; column < matrix.columns; column++) {
      centered.set(row, column, matrix.get(row, column) - mean[column]);
    }
  }
  return centered;
}

function normalizeRows(matrix) {
  const normalized = Matrix.zeros(matrix.rows, matrix.columns);
  for (let row = 0; row < matrix.rows; row++) {
    let norm = 0;
    for (let column = 0; column < matrix.columns; column++) {
      const value = matrix.get(row, column);
      norm += value * value;
    }
    norm = Math.sqrt(norm) || 1;
    for (let column = 0; column < matrix.columns; column++) {
      normalized.set(row, column, matrix.get(row, column) / norm);
    }
  }
  return normalized;
}

function computePca(centered, components) {
  const covariance = centered.transpose().mmul(centered).mul(1 / Math.max(1, centered.rows - 1));
  const evd = new EigenvalueDecomposition(covariance, { assumeSymmetric: true });
  const eigenvalues = Array.from(evd.realEigenvalues);
  const eigenvectors = evd.eigenvectorMatrix;

  const order = eigenvalues
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value)
    .slice(0, components);

  const basis = Matrix.zeros(eigenvectors.rows, order.length);
  for (let column = 0; column < order.length; column++) {
    basis.setColumn(column, eigenvectors.getColumn(order[column].index));
  }

  return {
    eigenvalues: order.map(entry => entry.value),
    basis,
    projected: centered.mmul(basis)
  };
}

function matrixToFloat32Array(matrix) {
  const buffer = new Float32Array(matrix.rows * matrix.columns);
  let offset = 0;
  for (let row = 0; row < matrix.rows; row++) {
    for (let column = 0; column < matrix.columns; column++) {
      buffer[offset++] = matrix.get(row, column);
    }
  }
  return buffer;
}

async function writeBinary(filePath, floatArray) {
  await writeFile(filePath, Buffer.from(floatArray.buffer, floatArray.byteOffset, floatArray.byteLength));
}

async function writePcaText(filePath, words, projected) {
  const out = createWriteStream(filePath, { encoding: "utf8" });
  out.write(`${words.length} ${projected.columns}\n`);
  for (let row = 0; row < projected.rows; row++) {
    const coords = [];
    for (let column = 0; column < projected.columns; column++) {
      coords.push(projected.get(row, column).toFixed(6));
    }
    out.write(`${words[row]} ${coords.join(" ")}\n`);
  }
  await new Promise((resolve, reject) => {
    out.end(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function main() {
  await mkdir(path.dirname(PCA_TEXT_OUTPUT), { recursive: true });

  console.log(`Loading vectors from ${INPUT_PATH} ...`);
  const { words, matrix, count, dimension } = await loadDataset(INPUT_PATH);
  console.log(`Loaded ${count} vectors with dimension ${dimension}.`);

  console.log("Centering matrix and computing PCA ...");
  const mean = computeMeanVector(matrix);
  const centered = centerMatrix(matrix, mean);
  const normalized = normalizeRows(matrix);
  const { eigenvalues, projected } = computePca(centered, COMPONENTS);
  console.log(`Top eigenvalues: ${eigenvalues.map(value => value.toFixed(6)).join(", ")}`);

  console.log("Writing data ...");
  await writeFile(META_OUTPUT, JSON.stringify({
    count,
    dimension,
    plotDimension: COMPONENTS
  }, null, 2));
  await writeFile(WORDS_OUTPUT, JSON.stringify(words));
  await writeBinary(VECTORS_OUTPUT, matrixToFloat32Array(normalized));
  await writeBinary(PCA_OUTPUT, matrixToFloat32Array(projected));

  console.log(`Writing PCA text file to ${PCA_TEXT_OUTPUT} ...`);
  await writePcaText(PCA_TEXT_OUTPUT, words, projected);
  console.log("Done.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
