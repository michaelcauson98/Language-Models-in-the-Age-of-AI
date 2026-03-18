// State/data of back end
const state = {
  words: [],
  exactLookup: new Map(),
  foldedLookup: new Map(),
  vectors: null,
  plotVectors: null,
  dimension: 0,
  plotDimension: 0,
  count: 0,
  ready: false
};

// Loads a JSON asset
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  return response.json();
}

// Loads binary float array and checks its size
async function fetchFloat32Array(url, expectedLength) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not load ${url} (${response.status}).`);
  const buffer = await response.arrayBuffer();
  const values = new Float32Array(buffer);
  if (values.length !== expectedLength) {
    throw new Error(`Unexpected data length in ${url}.`);
  }
  return values;
}

// Loads preprocessed model assets and rebuilds lookup maps
async function loadAssets(metaUrl, wordsUrl, vectorsUrl, plotUrl) {
  const meta = await fetchJson(metaUrl);
  state.count = Number(meta.count);
  state.dimension = Number(meta.dimension);
  state.plotDimension = Number(meta.plotDimension);
  state.words = await fetchJson(wordsUrl);

  state.vectors = await fetchFloat32Array(vectorsUrl, state.count * state.dimension);
  state.plotVectors = await fetchFloat32Array(plotUrl, state.count * state.plotDimension);

  state.exactLookup.clear();
  state.foldedLookup.clear();
  for (let index = 0; index < state.count; index++) {
    const word = state.words[index];
    state.exactLookup.set(word, index);
    const folded = String(word).trim().normalize("NFC").toLowerCase();
    if (!state.foldedLookup.has(folded)) {
      state.foldedLookup.set(folded, index);
    }
  }
  state.ready = true;
}

// Resolves a queried word to its vocabulary index
function getIndex(word) {
  const raw = String(word || "").trim().normalize("NFC");
  if (!raw) return -1;

  if (state.exactLookup.has(raw)) {
    return state.exactLookup.get(raw);
  }

  const folded = raw.toLowerCase();
  if (state.foldedLookup.has(folded)) {
    return state.foldedLookup.get(folded);
  }

  return -1;
}

// Returns full embedding vector for one vocabulary item
function getVector(index) {
  const offset = index * state.dimension;
  return state.vectors.subarray(offset, offset + state.dimension);
}

// Returns PCA plot coordinates for one vocabulary item
function getPlotVector(index) {
  const offset = index * state.plotDimension;
  return state.plotVectors.subarray(offset, offset + state.plotDimension);
}

// Computes dot product of two normalised embedding vectors
function dotWithVector(vectorA, vectorB) {
  let total = 0;
  for (let i = 0; i < state.dimension; i++) total += vectorA[i] * vectorB[i];
  return total;
}

function nearestToVector(vector, count, excluded = new Set()) {
  const matches = [];
  for (let index = 0; index < state.count; index++) {
    if (excluded.has(index)) continue;
    const score = dotWithVector(vector, getVector(index));
    if (matches.length < count) {
      matches.push({ index, score });
      matches.sort((a, b) => b.score - a.score);
      continue;
    }
    if (score > matches[matches.length - 1].score) {
      matches[matches.length - 1] = { index, score };
      matches.sort((a, b) => b.score - a.score);
    }
  }

  return matches.map(match => ({
    word: state.words[match.index],
    score: match.score
  }));
}

// Computes cosine similarity for two words
function handleSimilarity({ wordA, wordB }) {
  const indexA = getIndex(wordA);
  const indexB = getIndex(wordB);
  if (indexA < 0 || indexB < 0) {
    throw new Error("Both words must exist in the vocabulary.");
  }

  return {
    wordA: state.words[indexA],
    wordB: state.words[indexB],
    score: dotWithVector(getVector(indexA), getVector(indexB))
  };
}

// Finds nearest-neighbour for a queried word
function handleNeighbours({ word, count }) {
  const index = getIndex(word);
  if (index < 0) throw new Error(`"${word}" is not in the vocabulary.`);

  return {
    word: state.words[index],
    matches: nearestToVector(getVector(index), count, new Set([index]))
  };
}

// Handles vector algebra requests of the form x - y + z
function handleAnalogy({ positiveA, negative, positiveB, count }) {
  const indexA = getIndex(positiveA);
  const indexNegative = getIndex(negative);
  const indexB = getIndex(positiveB);
  if (indexA < 0 || indexNegative < 0 || indexB < 0) {
    throw new Error("All three words must exist in the vocabulary.");
  }

  const vectorA = getVector(indexA);
  const vectorNegative = getVector(indexNegative);
  const vectorB = getVector(indexB);
  const combined = new Float32Array(state.dimension);

  let norm = 0;
  for (let i = 0; i < state.dimension; i++) {
    const value = vectorA[i] - vectorNegative[i] + vectorB[i];
    combined[i] = value;
    norm += value * value;
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < state.dimension; i++) combined[i] /= norm;

  return {
    positiveA: state.words[indexA],
    negative: state.words[indexNegative],
    positiveB: state.words[indexB],
    matches: nearestToVector(combined, count, new Set([indexA, indexNegative, indexB]))
  };
}

// Prepares PCA plot data for the requested axes and highlights
function handlePlot({ x, y, maxPoints, highlightWords }) {
  const start = 0;
  const end = Math.min(state.count, maxPoints);

  const words = [];
  const xs = [];
  const ys = [];

  for (let index = start; index < end; index++) {
    const vector = getPlotVector(index);
    words.push(state.words[index]);
    xs.push(vector[x] || 0);
    ys.push(vector[y] || 0);
  }

  const requested = highlightWords
    .map(getIndex)
    .filter(index => index >= 0);

  return {
    words,
    x: xs,
    y: ys,
    highlightWords: requested.map(index => state.words[index]),
    highlightX: requested.map(index => getPlotVector(index)[x] || 0),
    highlightY: requested.map(index => getPlotVector(index)[y] || 0)
  };
}

// Key listener for front end events
self.addEventListener("message", async event => {
  const { id, type, payload } = event.data;

  try {
    if (type === "init") {
      await loadAssets(payload.metaUrl, payload.wordsUrl, payload.vectorsUrl, payload.plotUrl);
      self.postMessage({
        type: "ready",
        ok: true,
        payload: {
          words: state.count,
          dimension: state.dimension,
          plotDimension: state.plotDimension
        }
      });
      return;
    }

    if (!state.ready) throw new Error("Model is still loading.");

    let response;
    if (type === "plot") response = handlePlot(payload);
    else if (type === "similarity") response = handleSimilarity(payload);
    else if (type === "neighbours") response = handleNeighbours(payload);
    else if (type === "analogy") response = handleAnalogy(payload);
    else throw new Error(`Unknown worker request: ${type}`);

    self.postMessage({ id, ok: true, type, payload: response });
  } catch (error) {
    if (type === "init") {
      self.postMessage({ type: "ready", ok: false, error: error.message || String(error) });
    } else {
      self.postMessage({ id, ok: false, type, error: error.message || String(error) });
    }
  }
});
