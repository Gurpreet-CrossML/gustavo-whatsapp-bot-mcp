#!/usr/bin/env node
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const axios = require("axios");
const dotenv = require("dotenv");
const express = require("express");
const Fuse = require("fuse.js");
const { getMatchingProducts } = require("./openai-call.js");

// Load environment variables
dotenv.config();

const API_BASE_URL = process.env.API_BASE_URL;
const API_TOKEN = process.env.API_TOKEN;
const PORT = process.env.PORT || 3000;

if (!API_BASE_URL) {
    console.error("ERROR: API_BASE_URL environment variable is required");
    process.exit(1);
}

// Create an MCP server
const server = new McpServer({
    name: "Cortes54 Order Assistant",
    version: "1.0.0",
});

// --- API Helper ---
async function callApi(endpoint, method = "GET", data = null, params = {}) {
    try {
        const url = `${API_BASE_URL}${endpoint}`;
        console.log(`Calling API: ${method} ${url}`, params);

        // Clean params of undefined/null
        const cleanParams = Object.fromEntries(
            Object.entries(params).filter(([_, v]) => v != null)
        );

        const config = {
            method,
            url,
            headers: {
                "token": API_TOKEN,
                "Content-Type": "application/json",
            },
            params: cleanParams,
            data,
        };

        const response = await axios(config);
        return response.data;
    } catch (error) {
        console.error("API Error:", error.response?.data || error.message);
        // Return detailed error if available
        throw new Error(JSON.stringify(error.response?.data) || error.message);
    }
}

// --- Shared Business Logic Handlers ---

async function handleGetCustomers(name) {
    if (!name) throw new Error("Customer name is required");
    const cleanName = name.trim();
    // WaBot_listCust.asp?name=...
    return await callApi("WaBot_listCust.asp", "GET", null, { name: cleanName });
}

async function handleGetDestinations(code) {
    if (!code) throw new Error("Customer code is required");
    // WaBot_listDest.asp?code=...
    const destinations = await callApi("WaBot_listDest.asp", "GET", null, { code });

    // API returns: [{ Id, Name, Address, "Default destination": true/false }]
    // Assistant expects: DestinationId, DestinationName, DestinationAddress
    // We map the response.
    return Array.isArray(destinations)
        ? destinations.map(d => ({
            DestinationId: d.Id,
            DestinationName: d.Name,
            DestinationAddress: d.Address,
            IsDefault: d["Default destination"]
        }))
        : destinations;
}

async function handleGetProducts(customerCode, destinationId, productNames) {
    if (!customerCode) throw new Error("Customer code is required");

    // Normalize productNames to an array
    const namesArray = Array.isArray(productNames) ? productNames : [productNames].filter(Boolean);

    // Build params — destinationId is optional
    const params = { customerCode };
    if (destinationId) params.destinationId = destinationId;

    // WaBot_listProd.asp?customerCode=...&destinationId=... (optional)
    const products = await callApi("WaBot_listProd.asp", "GET", null, params);

    if (namesArray.length === 0) {
        return {
            status: "success",
            message: "No search terms provided, returning full catalog.",
            data: products
        };
    }

    // --- OPENAI CALL LOGIC ---
    try {
        const cohereResults = await getMatchingProducts(products, namesArray);
        return {
            status: "success",
            message: "Matching products retrieved, verify multiple matches from user.",
            data: cohereResults
        };
    } catch (error) {
        console.error("Error in Cohere matching:", error);

        const fuse = new Fuse(products, {
            keys: ["Description", "Alias"],
            threshold: 0.3,
            ignoreLocation: true,
            includeScore: true,
            useExtendedSearch: true
        });

        const STOPWORDS = ["di", "del", "della", "dei", "delle", "il", "lo", "la", "i", "gli", "le", "un", "uno", "una", "con", "per", "a", "da", "in", "su", "de"];
        const normalize = (str) => str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

        const resultsMap = namesArray.map(productName => {
            let finalProducts = [];

            // --- SMART SEARCH LOGIC (PER PRODUCT NAME) ---
            const normalizedName = normalize(productName);
            const tokens = normalizedName.trim().split(/\s+/)
                .filter(token => !STOPWORDS.includes(token.toLowerCase()));

            const queryTerms = tokens.map(token => {
                return token.length <= 3 ? `'${token}` : token;
            });
            const queryString = queryTerms.join(' ');

            let candidates = [];
            if (queryString) {
                candidates = fuse.search(queryString);
            }

            // Fallback A: Exact First Word
            if (candidates.length === 0 && queryTerms.length > 1) {
                candidates = fuse.search(queryTerms[0]);
            }

            // Fallback B: Best Subset Match (OR Search)
            if (candidates.length === 0) {
                const meaningfulTokens = tokens.filter(t => t.length > 3);
                if (meaningfulTokens.length > 0) {
                    const orQuery = meaningfulTokens.join(" | ");
                    candidates = fuse.search(orQuery);
                }
            }

            // Global Refinement & Ranking
            const refinedMatches = candidates.map(c => {
                const description = c.item.Description || "";
                const aliases = (c.item.Alias || []).join(" ");
                const itemStr = normalize(description + " " + aliases).toLowerCase();
                const itemWords = itemStr.split(/\s+/);
                let matchCount = 0;
                let exactMatches = 0;

                // Penalty for no description
                const noDescriptionPenalty = description.trim() === "" ? 1 : 0;

                tokens.forEach(t => {
                    const cleanT = t.toLowerCase();
                    if (itemStr.includes(cleanT)) matchCount++;
                    if (itemWords.includes(cleanT)) exactMatches++;
                });
                return { ...c, matchCount, exactMatchCount: exactMatches, noDescriptionPenalty };
            });

            refinedMatches.sort((a, b) => {
                if (b.exactMatchCount !== a.exactMatchCount) return b.exactMatchCount - a.exactMatchCount;
                if (b.matchCount !== a.matchCount) return b.matchCount - a.matchCount;
                if (a.noDescriptionPenalty !== b.noDescriptionPenalty) return a.noDescriptionPenalty - b.noDescriptionPenalty;
                return a.score - b.score;
            });

            if (refinedMatches.length > 0) {
                const maxExact = refinedMatches[0].exactMatchCount;
                const maxMatches = refinedMatches[0].matchCount;
                const minPenalty = refinedMatches[0].noDescriptionPenalty;

                finalProducts = refinedMatches
                    .filter(r => r.exactMatchCount === maxExact && r.matchCount === maxMatches && r.noDescriptionPenalty === minPenalty)
                    .map(r => {
                        const numericScore = (1 - r.score) * 100;
                        return {
                            ...r.item,
                            score: numericScore,
                            scoreFormatted: numericScore.toFixed(1) + "%"
                        };
                    });
            }

            // Return formatted sub-result
            if (finalProducts.length > 1) {
                return {
                    searchTerm: productName,
                    status: "success",
                    message: `There are multiple products found for "${productName}", first you need to match with the "${productName}", if there are very similar product then you should ask to user`,
                    data: finalProducts
                };
            } else {
                return {
                    searchTerm: productName,
                    status: "success",
                    message: finalProducts.length === 1 ? "Single Product found" : "No products found",
                    data: finalProducts
                };
            }
        });

        // If only one product was searched, return it directly to maintain backward compatibility for simple calls
        if (namesArray.length === 1) return resultsMap[0];

        return {
            status: "success",
            message: "Batch processing completed for multiple product names, verify multiple matches from user.",
            data: resultsMap
        };
    }
}

async function handlePlaceOrder(orderData) {
    // WaBot_createOrd.asp (POST)
    const response = await callApi("WaBot_createOrd.asp", "POST", orderData);

    if (response && response.result === true) {
        return { status: "order_placed" };
    } else {
        return { status: "order_failed", details: response };
    }
}

// --- MCP Tool Definitions ---

// Tool: get_customer_details
server.tool(
    "get_customer_details",
    "Verify customer identity and fetch details including default destination.",
    { name: z.string().describe("Customer name exactly as written") },
    async ({ name }) => {
        try {
            const result = await handleGetCustomers(name);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// Tool: get_customer_destinations
server.tool(
    "get_customer_destinations",
    "Fetch all destinations for a customer.",
    { code: z.union([z.string(), z.number()]).transform((val) => Number(val)).describe("Customer code") },
    async ({ code }) => {
        try {
            const result = await handleGetDestinations(code);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// Tool: get_customer_products
server.tool(
    "get_customer_products",
    "Fetch list of products available for a customer (supports single name or array of names).",
    {
        customerCode: z.coerce.number().describe("Customer code"),
        destinationId: z.coerce.number().optional().describe("Destination ID (optional)"),
        productName: z.union([z.string(), z.array(z.string())]).describe("Product name(s) to search"),
    },
    async ({ customerCode, destinationId, productName }) => {
        try {
            const result = await handleGetProducts(customerCode, destinationId, productName);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// Tool: place_order_request
server.tool(
    "place_order_request",
    "Place the order for the customer.",
    {
        customerCode: z.number().describe("Customer code"),
        destinationId: z.number().describe("Destination ID"),
        items: z.array(z.object({
            itemCode: z.string().describe("Code"),
            itemDescription: z.string().describe("Description"),
            um: z.string().describe("Unit"),
            qty: z.number().describe("Qty"),
        })).describe("Items"),
    },
    async (orderData) => {
        try {
            const result = await handlePlaceOrder(orderData);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// --- Express Server ---

const app = express();
app.use(express.json());

// MCP Endpoint
app.post("/mcp", async (req, res) => {
    try {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => {
            console.log("Request closed");
            transport.close();
            server.close();
        });
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
    } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
});

// REST Endpoints (using shared handlers)

// GET /customer?name=John%20Doe
app.get("/customer", async (req, res) => {
    try {
        res.json(await handleGetCustomers(req.query.name));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /destinations?code=419
app.get("/destinations", async (req, res) => {
    try {
        res.json(await handleGetDestinations(req.query.code));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /products?customerCode=419&destinationId=1&productName=A&productName=B
app.get("/products", async (req, res) => {
    try {
        // req.query.productName will be an array if multiple are passed, or a string if one is passed.
        res.json(await handleGetProducts(req.query.customerCode, req.query.destinationId, req.query.productName));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /order
app.post("/order", async (req, res) => {
    try {
        res.json(await handlePlaceOrder(req.body));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 405 for GET /mcp
app.get("/mcp", (req, res) => res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }));

app.listen(PORT, "0.0.0.0", () => {
});