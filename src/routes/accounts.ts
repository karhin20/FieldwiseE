import { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase";
import { authenticate, requireRole } from "../middleware/auth";

export async function accountRoutes(app: FastifyInstance) {
    /**
     * GET /api/accounts/search
     * Searches for distinct accounts (number and name) based on a query and optional district filter.
     * Uses the investigation_reports table as the source of truth for all known accounts.
     */
    app.get(
        "/api/accounts/search",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const query = request.query as {
                q?: string;
                district?: string;
                limit?: string;
            };

            const searchStr = query.q?.trim() || "";
            const limit = Math.min(20, Math.max(1, parseInt(query.limit || "10", 10) || 10));

            if (!searchStr) {
                return reply.send([]);
            }

            // We use investigation_reports because it holds the master list of accounts recorded in the field.
            let dbQuery = supabase
                .from("investigation_reports")
                .select("account_number, account_name, district")
                // Using distinct doesn't work perfectly with select in postgrest easily without RPC, 
                // so we will query and deduplicate in JS
                .or(`account_number.ilike.%${searchStr}%,account_name.ilike.%${searchStr}%`)
                .order("created_at", { ascending: false })
                .limit(limit * 5); // Fetch more to allow for deduplication

            if (query.district && query.district !== "all") {
                dbQuery = dbQuery.eq("district", query.district);
            }

            const { data, error } = await dbQuery;

            if (error) {
                console.error("Account search error:", error);
                return reply.code(500).send({ error: "Failed to search accounts" });
            }

            // Deduplicate by account number
            const uniqueAccounts = new Map();
            if (data) {
                for (const row of data) {
                    if (!uniqueAccounts.has(row.account_number)) {
                        uniqueAccounts.set(row.account_number, {
                            accountNumber: row.account_number,
                            accountName: row.account_name,
                            district: row.district
                        });
                    }
                }
            }

            return reply.send(Array.from(uniqueAccounts.values()).slice(0, limit));
        }
    );

    /**
     * GET /api/accounts/:accountNumber/balance
     * Retrieves the current debt and payment balance for a specific account.
     */
    app.get(
        "/api/accounts/:accountNumber/balance",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const { accountNumber } = request.params as { accountNumber: string };

            const { data, error } = await supabase
                .from("customer_transactions")
                .select("transaction_type, amount")
                .eq("account_number", accountNumber);

            if (error) {
                console.error("Account balance error:", error);
                return reply.code(500).send({ error: "Failed to fetch account balance" });
            }

            let totalCharges = 0;
            let totalPayments = 0;

            if (data) {
                for (const row of data) {
                    const amt = Number(row.amount);
                    if (row.transaction_type === "charge") {
                        totalCharges += amt;
                    } else if (row.transaction_type === "payment") {
                        totalPayments += amt;
                    }
                }
            }

            const balance = totalCharges - totalPayments; // Positive means debt, negative means credit

            return reply.send({
                accountNumber,
                totalCharges,
                totalPayments,
                balance
            });
        }
    );
}
