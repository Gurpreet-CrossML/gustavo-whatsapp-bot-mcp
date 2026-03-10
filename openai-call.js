const OpenAI = require("openai");
const dotenv = require("dotenv");
const { z } = require("zod");
const { zodTextFormat } = require("openai/helpers/zod");

dotenv.config();

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const MatchsResponseSchema = z.object({
  matches: z.array(
    z.object({
      Description: z.string(),
      Code: z.string(),
      Alias: z.array(z.string()),
      Score: z.number().refine((n) => n >= 0 && n <= 100, {
        message: "Score must be between 0 and 100",
      }),
    }),
  ),
});

const jsonSchema = zodTextFormat(MatchsResponseSchema, "event");

const BASE_SYSTEM_PROMPT = `
You are a product matching assistant. Match the user's inquiry to items in the provided product catalog only.

**Matching Strategy (PHASED FALLBACK):**
1. **PHASE 1 (Search Description ONLY):**
   - Look for the user's search query ONLY within the product "Description" field.
   - If any products match even partially (Score > 0), return ONLY these results and **STOP**. Do not look at aliases.
2. **PHASE 2 (Search Alias ONLY):**
   - **ONLY** if Phase 1 found zero matches, then look for the search query within the "Alias" arrays.
   - If products are found via alias, return them. Perfect alias hits get a score of **100**.

**Scoring Rules:**
- **High Score (100)**: If the search query perfectly matches the active field (Description in P1, Alias in P2), the score MUST be 100.

**FastOrder_Generico entry rules:**
- **Multiple matches (2 or more real results):** ALWAYS append one "FastOrder_Generico" entry at the very end, regardless of scores. This gives the user the option to reject all suggestions.
- **Single match with score >= 95:** Do NOT include a "FastOrder_Generico" entry.
- **Single match with score < 95:** Append one "FastOrder_Generico" entry at the very end.
- **Zero matches in both Phase 1 and Phase 2:** Return a single "NOT_FOUND" entry instead of FastOrder_Generico.

**FastOrder_Generico entry format:**
- **Set "Code" to:** FastOrder_Generico
- **Set "Description" to:** THE EXACT TEXT THE USER SEARCHED FOR (copy it verbatim)
- **Set "Alias" to:** empty array []
- **Set "Score" to:** 0

**NOT_FOUND entry format (zero matches only):**
- **Set "Code" to:** NOT_FOUND
- **Set "Description" to:** THE EXACT TEXT THE USER SEARCHED FOR (copy it verbatim)
- **Set "Alias" to:** empty array []
- **Set "Score" to:** 0

**CRITICAL EXAMPLES:**

Example 1 – Single perfect match, no generic:
Search: "apple" | Catalog: [{ Description: "FRESH APPLE" }]
Phase 1 finds 1 match → Score 100 → single match, score >= 95 → return match ONLY, no generic.

Example 2 – Multiple matches, always add generic:
Search: "bife ancho" | Both "ENTRECOTE URU" and "ENTRECOTE WAGYU" have alias "BIFE ANCHO"
Phase 1: 0 → Phase 2: 2 alias matches → multiple results → return both matches AND one FastOrder_Generico.

Example 3 – Zero matches:
Search: "xyzproduct" | Nothing found in descriptions or aliases
Phase 1: 0 → Phase 2: 0 → return one NOT_FOUND entry.

Example 4 – Alias found:
Search: "kumquat" | "CITRUS MIX" has alias ["kumquat"]
Phase 1: 0 → Phase 2: 1 alias match, Score 100 → single match, score >= 95 → return match ONLY, no generic.

**MANDATORY RULES:**
1. **STRICT VERBATIM**: The "Description" field in the output MUST be an exact, character-for-character copy of the catalog Description. Never add aliases or summary text to it.
2. **NO MODIFICATION**: If catalog description is "REALE USA", output MUST be "REALE USA". Never output "REALE USA ANGUS".
3. **PHASE INDEPENDENCE**: Phase 1 results ALWAYS hide Phase 2 results.
4. **JSON ONLY**: No markdown, no conversational text.
`;

async function getMatchingProducts(products, userProducts) {
  const products_string = products
    .map(
      (p) =>
        `- {
  Description: ${p.Description},
Code: ${p.Code},
Alias: ${p.Alias ? `[${p.Alias.map((a) => `"${a}"`).join(", ")}]` : "[]"}
          }`,
    )
    .join("\n");
  const systemPrompt = `${BASE_SYSTEM_PROMPT}
    
  ** Product Catalog(match against these items only):**
  ${products_string} `;

  const results = userProducts.map(async (product) => {
    const response = await openai.responses.create({
      model: "gpt-4.1",
      input: product,
      instructions: systemPrompt,
      text: {
        format: jsonSchema,
      },
      temperature: 0
    });

    return {
      product: product,
      matches: JSON.parse(response.output_text)?.matches || [],
    };
  });

  return await Promise.all(results);
}

module.exports = { getMatchingProducts };