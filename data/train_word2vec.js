import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const w2v = require("word2vec");

// Train a model from a corpus
w2v.word2vec(
  "../data/corpus_clean.txt",  // input text file
  "../data/vectors.txt",       // output model file
  { size: 100 },               // training parameters
  () => {
    console.log("Training complete");

    // Load the trained model
    w2v.loadModel("vectors.txt", (err, model) => {
      if (err) throw err;

      console.log("Vocabulary size:", model.words);
      console.log("Vector dimension:", model.size);

      // Example similarity query
      const sim = model.similarity("king", "queen");
      console.log("Similarity king vs queen:", sim);
    });
  }
);
