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

async function handleGetProducts(customerCode, productNames, destinationId = null) {
    if (!customerCode) throw new Error("Customer code is required");

    // Normalize productNames to an array
    const namesArray = Array.isArray(productNames) ? productNames : [productNames].filter(Boolean);

    // Build params object - include destinationId if provided
    const params = { customerCode };
    if (destinationId) {
        params.destinationId = destinationId;
    }

    // WaBot_listProd.asp?customerCode=...&destinationId=... (optional)
    const products = await callApi("WaBot_listProd.asp", "GET", null, params);

    if (namesArray.length === 0) {
        return {
            status: "success",
            message: "No search terms provided, returning full catalog for destination.",
            data: products
        };
    }

    // --- OPENAI CALL LOGIC ---
    try{
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
    `Verify customer identity and retrieve essential customer information including default destination.
    
    This tool performs customer lookup by name to confirm identity and retrieve core customer data. It returns the customer's 
    unique code, registered name, default delivery destination, and a flag indicating whether the customer has multiple destinations. 
    This is typically the first step in any order placement workflow.
    
    Use this tool when you need to:
    - Verify and confirm a customer's identity by name
    - Retrieve a customer's unique code for subsequent API calls
    - Get the customer's default delivery destination
    - Determine if you need to prompt the user to select among multiple destinations
    - Initiate a new order process for a customer
    
    Parameters:
    @param {string} name - The customer's name exactly as registered in the system. The search performs exact matching.
    
    Returns customer information with the following structure:
    [
    {
        "Code": "unique customer identifier/code",
        "Name": "registered customer name",
        "DestinationId": "numeric code of the default destination",
        "DestinationName": "name of the default delivery destination",
        "DestinationAddress": "full address of the default destination",
        "ChooseDestination": "0 = customer has only one destination (or default set), 1 = customer has multiple destinations (ask user to choose)"
    }
    ]
    `,
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
    `Retrieve all delivery destinations associated with a customer account.
    
    This tool fetches the complete list of delivery locations where a customer can receive orders. Each destination 
    includes its unique identifier, name, full address, and a flag indicating if it's the default delivery location. 
    Use this tool when a customer has multiple delivery locations and needs to specify where their order should be sent.
    
    Use this tool when you need to:
    - Display all available delivery locations for a customer
    - Allow the customer to select a specific delivery destination
    - Verify destination information before placing an order
    - Check which destination is marked as the customer's default
    - Ensure the order goes to the correct delivery address
    
    Parameters:
    @param {number} code - The customer's unique code (obtained from get_customer_details).
    
    Returns an array of all destination objects with the following structure:
    [
    {
        "DestinationId": "unique identifier for this destination",
        "DestinationName": "name/label of the destination (e.g., 'Main Office', 'Warehouse')",
        "DestinationAddress": "complete delivery address for this location",
        "IsDefault": "true if this is the customer's default destination, false otherwise"
    }
    ]
    `,
    { code: z.union( z.number()).transform((val) => Number(val)).describe("Customer code") },
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
    `Fetch and search for products available for a specific customer.
    
    This tool retrieves the complete product catalog for a customer and performs intelligent fuzzy matching 
    against product names. It uses multi-stage fallback strategies to find matching products even with partial 
    names, spelling variations, or typos. Results are ranked by relevance score with exact matches prioritized.
    
    Use this tool when you need to:
    - Browse all available products for a customer without destination filtering
    - Search for products by name with fuzzy matching capabilities
    - Get product details including descriptions, aliases, and priority information
    - Handle batch searches for multiple product names simultaneously
    
    Parameters:
    @param {number} customerCode - The unique code/ID of the customer to fetch products for.
    @param {string|string[]} productName - The name(s) of the product(s) to search for. Can be a single string 
                                          or an array of strings. If empty or not provided, returns full catalog.
    
    Returns a list of matching products with the following structure for each search term:
    [
     {
        "Code": "numeric code identifying the product",
        "Description": "detailed product description",
        "Priority": "numeric priority level",
        "Alias": ["array", "of", "alternative names"],
        "score": "relevance score as percentage (0-100)",
        "scoreFormatted": "formatted score string (e.g., '95.3%')"
     }
    ]
    
    When multiple products match a search term, all matches are returned ranked by relevance. 
    If no matches are found, an empty list is returned.
    `,
    {
        customerCode: z.coerce.number().describe("Customer code"),
        productName: z.union([z.array(z.string())]).describe("Product name(s) to search"),
    },
    async ({ customerCode, productName }) => {
        try {
            const result = await handleGetProducts(customerCode, productName);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// Tool: get_customer_products_by_destination
server.tool(
    "get_customer_products_by_destination",
    `Fetch and search for products available for a specific customer at a specific delivery destination.
    
    This tool retrieves the product catalog filtered by both customer and destination, ensuring only products 
    available for the selected delivery location are returned. It uses the same intelligent fuzzy matching as 
    the standard product search, with multi-stage fallback strategies for partial matches and typos. 
    Results are ranked by relevance score with exact matches prioritized.
    
    Use this tool when you need to:
    - Search for products specific to a customer and destination combination
    - Ensure product availability at the selected delivery location
    - Handle orders going to different customer destinations with location-specific availability
    - Respect destination-based inventory or product restrictions
    - Perform batch searches for multiple product names at a specific location
    
    Parameters:
    @param {number} customerCode - The unique code/ID of the customer to fetch products for.
    @param {number} destinationId - The unique ID of the delivery destination to filter products by. 
                                   Must be a valid destination associated with the customer.
    @param {string|string[]} productName - The name(s) of the product(s) to search for. Can be a single string 
                                          or an array of strings. If empty or not provided, returns full catalog for destination.
    
    Returns a list of matching products available at the specified destination with the following structure:
    [
     {
        "Code": "numeric code",
        "Description": "string",
        "Priority": "numeric code",
        "Alias": [
            "string",
            "string",
        ]
     }
    ]
    `,
    {
        customerCode: z.coerce.number().describe("Customer code"),
        destinationId: z.coerce.number().describe("Destination ID to filter products"),
        productName: z.union([z.array(z.string())]).describe("Product name(s) to search"),
    },
    async ({ customerCode, destinationId, productName }) => {
        try {
            const result = await handleGetProducts(customerCode, productName, destinationId);
            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (error) {
            return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
        }
    }
);

// Tool: place_order_request
server.tool(
    "place_order_request",
    `Submit and finalize a customer order for processing.
    
    This tool submits the complete order details to the backend system for processing. It requires confirmation of the customer, 
    their selected delivery destination, and itemized list of products with quantities. The system validates all information 
    and returns a status indicating success or failure. This is the final step in the order workflow and should only be called 
    after all order details have been confirmed with the customer.
    
    Use this tool when you need to:
    - Finalize and submit an order after customer confirmation
    - Process an order with specific items and quantities
    - Send orders to a specific delivery destination
    - Complete the entire order workflow
    - Get confirmation that an order has been successfully placed
    
    Parameters:
    @param {number} customerCode - The unique customer code (obtained from get_customer_details).
    @param {number} destinationId - The ID of the selected delivery destination (obtained from get_customer_destinations).
    @param {object[]} items - An array of ordered items, each containing:
        @param {string} itemCode - The product's unique code identifier
        @param {string} itemDescription - The product's description/name for reference
        @param {string} um - Unit of measure for the product (e.g., 'kg', 'units', 'boxes')
        @param {number} qty - The quantity to order for this item (must be a positive number)
    
    Returns the order submission status with the following structure:
    {
        "status": "order_placed (success) | order_failed (failure)",
        "details": "Additional information including order ID on success, error details on failure"
    }
    
    Important: Always confirm all order details (customer, destination, items, quantities) with the customer before calling this tool.
    Once submitted, the order cannot be modified through this tool - contact support for changes.
     `,
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

// GET /products?customerCode=419&productName=A&productName=B
app.get("/products", async (req, res) => {
    try {
        // req.query.productName will be an array if multiple are passed, or a string if one is passed.
        res.json(await handleGetProducts(req.query.customerCode, req.query.productName));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /products-by-destination?customerCode=419&destinationId=1&productName=A&productName=B
app.get("/products-by-destination", async (req, res) => {
    try {
        // req.query.productName will be an array if multiple are passed, or a string if one is passed.
        res.json(await handleGetProducts(req.query.customerCode, req.query.productName, req.query.destinationId));
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