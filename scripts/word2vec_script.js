// State of front end
const state = {
  worker: null,
  requestId: 0,
  pending: new Map(),
  ready: false
};

// Updates status pill at top of page
function setStatus(message, isError = false) {
  const el = document.getElementById("embeddingStatus");
  if (!el) return;
  el.textContent = message || "";
  el.style.color = isError ? "#b91c1c" : "#2c7be5";
  el.style.background = isError ? "rgba(185, 28, 28, 0.08)" : "rgba(44,123,229,0.08)";
  el.style.borderColor = isError ? "rgba(185, 28, 28, 0.16)" : "rgba(44,123,229,0.16)";
}

// Prevent HTML injection
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

// Send message to worker
function workerRequest(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++state.requestId;
    state.pending.set(id, { resolve, reject });
    state.worker.postMessage({ id, type, payload });
  });
}

// Handle incoming messages from worker
function handleWorkerMessage(event) {
  const { id, ok, type, payload, error } = event.data;

  if (type === "ready" && ok) {
    state.ready = true;
    setStatus("Model loaded.");
    populateComponentSelectors(payload.plotDimension);
    updatePlot();
    updateSimilarity();
    updateNeighbours();
    updateAnalogy();
    return;
  }

  if (type === "ready" && !ok) {
    setStatus(error || "Could not load vectors.txt.", true);
    return;
  }

  const pending = state.pending.get(id);
  if (!pending) return;
  state.pending.delete(id);

  if (ok) pending.resolve(payload);
  else pending.reject(new Error(error || "Worker request failed."));
}

// Populates dropdown menu with component names (useful if lots of components)
function populateComponentSelectors(dimension) {
  const ids = ["xComponent", "yComponent"];
  ids.forEach((id, index) => {
    const select = document.getElementById(id);
    const previous = Number(select.value || index);
    select.innerHTML = "";
    for (let component = 0; component < dimension; component++) {
      const option = document.createElement("option");
      option.value = String(component);
      option.textContent = `Component ${component + 1}`;
      select.appendChild(option);
    }
    select.value = String(Math.min(previous, Math.max(0, dimension - 1)));
  });
}

// Parse comma-separated word list from input
function parseWordsList(value) {
  return String(value || "")
    .split(",")
    .map(word => word.trim())
    .filter(Boolean);
}

// Update the PCA plot based on selected components and highlighted words
async function updatePlot() {
  if (!state.ready) return;
  try {
    const x = Number(document.getElementById("xComponent").value || 0);
    const y = Number(document.getElementById("yComponent").value || 1);
    const maxPoints = Math.max(10, Math.min(10000, Number(document.getElementById("maxPoints").value) || 5000));
    const highlightWords = parseWordsList(document.getElementById("highlightWords").value);

    const plot = await workerRequest("plot", { x, y, maxPoints, highlightWords });
    renderPlot(plot, x, y);
  } catch (error) {
    setStatus(error.message, true);
  }
}

// Render the PCA plot using Plotly (using workers plot object)
function renderPlot(plot, x, y) {
  const traces = [{
    type: "scatter",
    text: plot.words,
    x: plot.x,
    y: plot.y,
    mode: "markers",
    hovertemplate: "%{text}<extra></extra>",
    marker: {
      size: 7,
      color: "#93c5fd",
      opacity: 0.75
    }
  }];

  if (plot.highlightWords.length > 0) {
    traces.push({
      type: "scatter",
      text: plot.highlightWords,
      x: plot.highlightX,
      y: plot.highlightY,
      mode: "markers+text",
      textposition: "top center",
      hovertemplate: "%{text}<extra></extra>",
      marker: {
        size: 10,
        color: "#dc2626",
        opacity: 0.95
      },
      textfont: { size: 12, color: "#7f1d1d" }
    });
  }

  const layout = {
    margin: { l: 1, r: 1, t: 1, b: 75 },
    xaxis: { title: `Component ${x + 1}`, automargin: true },
    yaxis: { title: `Component ${y + 1}`, automargin: true },
    paper_bgcolor: "#ffffff",
    plot_bgcolor: "#ffffff",
    showlegend: false
  };

  Plotly.newPlot("plot", traces, layout, { responsive: true, displaylogo: false });
}

// Sends words to worker for similarity check
async function updateSimilarity() {
  const output = document.getElementById("similarityResult");
  if (!state.ready) {
    output.textContent = "Model still loading.";
    return;
  }

  try {
    const wordA = document.getElementById("similarityWordA").value.trim();
    const wordB = document.getElementById("similarityWordB").value.trim();
    const result = await workerRequest("similarity", { wordA, wordB });
    output.textContent = result.score.toFixed(4);
  } catch (error) {
    output.textContent = error.message;
  }
}

// Sends query and no. neighbours to worker for neighbour check
async function updateNeighbours() {
  const output = document.getElementById("neighbourResult");
  if (!state.ready) {
    output.textContent = "Model still loading.";
    return;
  }

  try {
    const word = document.getElementById("neighbourWord").value.trim();
    const count = Math.max(1, Math.min(20, Number(document.getElementById("neighbourCount").value) || 8));
    const result = await workerRequest("neighbours", { word, count });
    output.innerHTML = [
      `<p class="w2v-result-summary">Nearest words to <span class="w2v-inline-code">${escapeHtml(result.word)}</span></p>`,
      `<ol class="w2v-neighbours">${result.matches.map(match =>
        `<li><span>${escapeHtml(match.word)}</span> <span class="w2v-neighbour-score">${match.score.toFixed(4)}</span></li>`
      ).join("")}</ol>`
    ].join("");
  } catch (error) {
    output.textContent = error.message;
  }
}

// Sends vectors to worker to find nearest match
async function updateAnalogy() {
  const output = document.getElementById("analogyResult");
  if (!state.ready) {
    output.textContent = "Model still loading.";
    return;
  }

  try {
    const positiveA = document.getElementById("analogyPositiveA").value.trim();
    const negative = document.getElementById("analogyNegative").value.trim();
    const positiveB = document.getElementById("analogyPositiveB").value.trim();
    const count = Math.max(1, Math.min(20, Number(document.getElementById("analogyCount").value) || 8));
    const result = await workerRequest("analogy", { positiveA, negative, positiveB, count });
    output.innerHTML = [
      `<p class="w2v-result-summary"><span class="w2v-inline-code">${escapeHtml(result.positiveA)}</span> - <span class="w2v-inline-code">${escapeHtml(result.negative)}</span> + <span class="w2v-inline-code">${escapeHtml(result.positiveB)}</span></p>`,
      `<ol class="w2v-neighbours">${result.matches.map(match =>
        `<li><span>${escapeHtml(match.word)}</span> <span class="w2v-neighbour-score">${match.score.toFixed(4)}</span></li>`
      ).join("")}</ol>`
    ].join("");
  } catch (error) {
    output.textContent = error.message;
  }
}

// Add listeners
function bindEvents() {
  document.getElementById("similarityBtn").addEventListener("click", updateSimilarity);
  document.getElementById("neighbourBtn").addEventListener("click", updateNeighbours);
  document.getElementById("analogyBtn").addEventListener("click", updateAnalogy);

  ["xComponent", "yComponent", "maxPoints", "highlightWords"].forEach(id => {
    document.getElementById(id).addEventListener("change", updatePlot);
  });
  document.getElementById("highlightWords").addEventListener("input", updatePlot);
}

// Initialise the page and worker
function boot() {
  bindEvents();
  state.worker = new Worker("scripts/word2vec_worker.js");
  state.worker.addEventListener("message", handleWorkerMessage);
  state.worker.postMessage({
    type: "init",
    payload: {
      metaUrl: new URL("data/word2vec_meta.json", window.location.href).toString(),
      wordsUrl: new URL("data/word2vec_words.json", window.location.href).toString(),
      vectorsUrl: new URL("data/word2vec_vectors.bin", window.location.href).toString(),
      plotUrl: new URL("data/word2vec_pca.bin", window.location.href).toString()
    }
  });
}

boot();
