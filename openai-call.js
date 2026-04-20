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
- **Conditional Generic Entry**:
  - If the highest match score is **>= 95**: DO NOT include a "FastOrder_Generico" entry.
  - If the highest match score is **< 95**: Append one "FastOrder_Generico" entry at the very end.

**FastOrder_Generico entry (Conditional):**
- **Set "code" to:** FastOrder_Generico
- **Set "description" to:** THE EXACT TEXT THE USER SEARCHED FOR (copy it verbatim)
- **Set "alias" to:** empty array []
- **Set "score" to:** 0

**CRITICAL EXAMPLE (Fruit Scenario):**
Search query: "apple"
Catalog has:
- Product 1: Description: "FRESH APPLE", Alias: []
- Product 2: Description: "FRUIT BASKET", Alias: ["RED APPLE", "GREEN APPLE"]

**Logic:**
Phase 1 finds Product 1 contains "apple" in its description. 
**RESULT**: Return Product 1 (Score: 100) and NO generic entry. Product 2 is **EXCLUDED** because Phase 1 found a match.

Search query: "kumquat" (not in any description, but is an alias of "CITRUS MIX")
1. Phase 1 finds zero description hits for "kumquat".
2. Phase 2 searches aliases and finds "kumquat" in "CITRUS MIX" alias.
**RESULT**: Return "CITRUS MIX" (Score: 100).

**MANDATORY RULES:**
1. **STRICT VERBATIM**: The "description" field in the output MUST be an exact, character-for-character copy of the catalog Description. Never add aliases or summary text to it.
2. **NO MODIFICATION**: If physical catalog description is "REALE USA", output MUST be "REALE USA". Never output "REALE USA ANGUS".
3. **PHASE INDEPENDENCE**: Phase 1 results ALWAY hide Phase 2 results.
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