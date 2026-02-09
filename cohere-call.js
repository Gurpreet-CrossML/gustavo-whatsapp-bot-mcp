const CohereClientV2 = require("cohere-ai").CohereClientV2;
const dotenv = require("dotenv");

dotenv.config();

const COHERE_MODEL = process.env.COHERE_MODEL || "command-r7b-12-2024";
const cohere = new CohereClientV2({ token: process.env.COHERE_API_KEY });

const jsonSchema = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          Description: { type: "string" },
          Code: { type: "string" },
          Alias: { type: "array", items: { type: "string" } },
          Score: {
            type: "number",
            description:
              "A score between 0 and 100 indicating the confidence of the match",
          },
        },
        required: ["Description", "Code", "Score"],
      },
    },
  },
  required: ["matches"],
};

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
  const systemPrompt = `Given the following list of products, find the best match for the user's product and return the product description, code and score for each match. If no product matches the user's product, return an empty array. The score should be a number between 0 and 100 indicating the confidence of the match.
    Products:
    ${products_string}`;

  const results = userProducts.map(async (product) => {
    const response = await cohere.chat({
      messages: [
        {
          role: "system",
          content: systemPrompt,
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Find the best match for the following product: ${product}`,
            },
          ],
        },
      ],
      temperature: 0.3,
      model: COHERE_MODEL,
      responseFormat: {
        type: "json_object",
        jsonSchema: jsonSchema,
      },
    });

    return {
      product: product,
      matches: JSON.parse(response.message.content[0].text)?.matches || [],
    };
  });

  return await Promise.all(results);
}

module.exports = { getMatchingProducts };