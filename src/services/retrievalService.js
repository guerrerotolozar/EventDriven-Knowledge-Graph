/**
 * src/services/retrievalService.js
 * 
 * Hybrid Retrieval Engine:
 * - Mathematical Time-Decay Ranking
 * - Media/ Cross-Pollination Inspiration
 */

const { buscarEpisodica } = require('../repositories/vectorRepository');

const DECAY_LAMBDA = 0.02; // Decay rate per hour
const WEIGHT_SIMILARITY = 0.50;
const WEIGHT_TIME = 0.35;
const WEIGHT_IMPORTANCE = 0.15;
const MEDIA_THRESHOLD = 0.78;

/**
 * Searches episodic memories applying the time-decay formula.
 */
async function recuperarContexto(query, topK = 5) {
    const rawResults = await buscarEpisodica(query, topK * 2);
    const now = Date.now();

    const scored = rawResults.map(item => {
        const itemDate = new Date(item.created_at).getTime();
        const hoursElapsed = Math.max(0, (now - itemDate) / (1000 * 60 * 60));
        
        // Time decay factor
        const timeFactor = Math.exp(-DECAY_LAMBDA * hoursElapsed);
        
        // Final composite score
        const score = (WEIGHT_SIMILARITY * item.similarity) + 
                      (WEIGHT_TIME * timeFactor) + 
                      (WEIGHT_IMPORTANCE * item.importance);

        return {
            ...item,
            hours_elapsed: parseFloat(hoursElapsed.toFixed(2)),
            composite_score: parseFloat(score.toFixed(4))
        };
    });

    // Sort by composite score descending
    scored.sort((a, b) => b.composite_score - a.composite_score);
    return scored.slice(0, topK);
}

/**
 * Checks for relevant media inspirations (Reels/Videos) matching the current query.
 */
async function buscarInspiracionMedia(query) {
    const mediaResults = await buscarEpisodica(query, 3, 'MEDIA_INSPIRATION');
    return mediaResults.filter(m => m.similarity >= MEDIA_THRESHOLD);
}

module.exports = {
    recuperarContexto,
    buscarInspiracionMedia
};
