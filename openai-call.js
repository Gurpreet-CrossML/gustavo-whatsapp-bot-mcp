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

**Matching Steps:**
1. Review each product's code, description, and aliases.
2. For each query, compare against product descriptions AND aliases for semantic similarity.
3. Assign a similarity score (0–100):
   - 100: Exact match (all key terms present in description or alias).
   - 70-99: High similarity (most key terms match).
   - 50-69: Partial match (some key terms match).
   - Below 50: Poor match.
4. Return logic:
   - If best match score >= 95: Return only those high-scoring matches.
   - If best match score < 95: Return all matches AND add one additional entry at the end.

**For the additional entry when score < 95:**
- Set "code" to: FastOrder_Generico
- Set "description" to: THE EXACT TEXT THE USER SEARCHED FOR (copy it verbatim)
- Set "alias" to: empty array []
- Set "score" to: 0

**Output Format (JSON only, no markdown, no extra text):**
[
  {
    "code": "catalog_code",
    "description": "catalog_description",
    "alias": ["alias1", "alias2"],
    "score": 85
  }
]

**CRITICAL EXAMPLES:**

If user searches for "alfajores Nero clásico" and best match is 70:
[
  {"code": "006478", "description": "ALFAJORES MERENGUE CLASICO HAVANNA (1 x 12)", "alias": [], "score": 70},
  {"code": "006477", "description": "ALFAJORES MERENGUE CLASICO HAVANNA (1 x 6)", "alias": [], "score": 70},
  {"code": "FastOrder_Generico", "description": "alfajores Nero clásico", "alias": [], "score": 0}
]

If user searches for "bon o bon nero" and best match is 70:
[
  {"code": "001817", "description": "BOMBON BON O BON LECHE", "alias": [], "score": 70},
  {"code": "FastOrder_Generico", "description": "bon o bon nero", "alias": [], "score": 0}
]

The description field in the FastOrder_Generico entry must NEVER be "FastOrder_Generico" - it must be the user's search text.
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
    
  **Product Catalog (match against these items only):**
    ${products_string}`;

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