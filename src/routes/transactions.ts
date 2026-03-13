import { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase";
import { createTransactionSchema } from "../schemas/transactions";
import { authenticate, requireRole } from "../middleware/auth";

export async function transactionRoutes(app: FastifyInstance) {
    /**
     * POST /api/transactions
     * Managers record a new charge or payment.
     */
    app.post(
        "/api/transactions",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const user = request.user!;

            const parsed = createTransactionSchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.code(400).send({
                    error: "Validation failed",
                    details: parsed.error.flatten().fieldErrors,
                });
            }

            const data = parsed.data;
            let finalReportId = data.referenceReportId || null;

            // Auto-link: If no report ID provided, find the latest report for this account
            if (!finalReportId) {
                const { data: latestReport } = await supabase
                    .from("investigation_reports")
                    .select("id")
                    .eq("account_number", data.accountNumber)
                    .order("created_at", { ascending: false })
                    .limit(1)
                    .single();

                if (latestReport) {
                    finalReportId = latestReport.id;
                }
            }

            const { data: transaction, error } = await supabase
                .from("customer_transactions")
                .insert({
                    recorded_by: user.id,
                    account_number: data.accountNumber,
                    account_name: data.accountName,
                    district: data.district,
                    transaction_type: data.transactionType,
                    amount: data.amount,
                    description: data.description || null,
                    reference_report_id: finalReportId,
                })
                .select()
                .single();

            if (error) {
                console.error("Transaction creation error:", error);
                return reply.code(500).send({ error: "Failed to record transaction" });
            }

            return reply.code(201).send({ transaction: formatTransaction(transaction) });
        }
    );

    /**
     * GET /api/transactions
     * Managers can view transactions. Supports pagination and filtering.
     */
    app.get(
        "/api/transactions",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const query = request.query as {
                page?: string;
                limit?: string;
                district?: string;
                type?: string;
                search?: string;
                period?: string;
                date?: string;
                referenceReportId?: string;
            };

            const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(query.limit || "50", 10) || 50));
            const offset = (page - 1) * limit;

            let dbQuery = supabase
                .from("customer_transactions")
                .select("*", { count: "exact" })
                .order("created_at", { ascending: false })
                .range(offset, offset + limit - 1);

            if (query.district && query.district !== "all") {
                dbQuery = dbQuery.eq("district", query.district);
            }
            if (query.type && query.type !== "all") {
                dbQuery = dbQuery.eq("transaction_type", query.type);
            }
            if (query.search) {
                // Search by account number or name
                dbQuery = dbQuery.or(`account_number.ilike.%${query.search}%,account_name.ilike.%${query.search}%`);
            }
            if (query.referenceReportId) {
                dbQuery = dbQuery.eq("reference_report_id", query.referenceReportId);
            }
            if (query.period && query.period !== "all") {
                const targetDateStr = query.date || new Date().toISOString();
                const targetDate = new Date(targetDateStr);
                let startDate, endDate;

                if (query.period === 'daily') {
                    startDate = new Date(targetDate.setHours(0, 0, 0, 0));
                    endDate = new Date(startDate.getTime() + 86400000);
                } else if (query.period === 'weekly') {
                    // Monday is the start of the week
                    const day = targetDate.getDay();
                    const diff = targetDate.getDate() - day + (day === 0 ? -6 : 1);
                    startDate = new Date(targetDate.setDate(diff));
                    startDate.setHours(0, 0, 0, 0);
                    endDate = new Date(startDate.getTime() + 7 * 86400000);
                } else if (query.period === 'monthly') {
                    startDate = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1);
                    endDate = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 1);
                }

                if (startDate && endDate) {
                    dbQuery = dbQuery.gte("created_at", startDate.toISOString());
                    dbQuery = dbQuery.lt("created_at", endDate.toISOString());
                }
            }

            const { data: transactions, error, count } = await dbQuery;

            if (error) {
                console.error("Transactions fetch error:", error);
                return reply.code(500).send({ error: "Failed to fetch transactions" });
            }

            return reply.send({
                transactions: (transactions || []).map(formatTransaction),
                pagination: {
                    page,
                    limit,
                    total: count || 0,
                    totalPages: Math.ceil((count || 0) / limit),
                },
            });
        }
    );

    /**
     * GET /api/transactions/stats
     * Returns aggregated statistics for the Funds Analytics dashboard.
     */
    app.get(
        "/api/transactions/stats",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const query = request.query as { period?: string; date?: string; district?: string };
            const period = query.period || 'all';
            const date = query.date || null;
            const district = query.district || 'all';

            // Call the optimized Postgres function with the period and district arguments
            const { data: stats, error } = await supabase.rpc("get_transaction_stats", {
                p_period: period,
                p_date: date,
                p_district: district
            });

            if (error) {
                console.error("Transactions stats RPC error:", error);
                return reply.code(500).send({ error: "Failed to calculate transaction statistics" });
            }

            return reply.send(stats);
        }
    );

    /**
     * DELETE /api/transactions/:id
     * Managers can delete a transaction if a mistake was made.
     */
    app.delete(
        "/api/transactions/:id",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const { id } = request.params as { id: string };

            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(id)) {
                return reply.code(400).send({ error: "Invalid transaction ID format" });
            }

            const { error: deleteErr } = await supabase
                .from("customer_transactions")
                .delete()
                .eq("id", id);

            if (deleteErr) {
                console.error("Transaction delete error:", deleteErr);
                return reply.code(500).send({ error: "Failed to delete transaction" });
            }

            return reply.send({ message: "Transaction deleted successfully" });
        }
    );

    /**
     * PUT /api/transactions/:id
     * Update an existing transaction (Admin/Manager only)
     */
    app.put(
        "/api/transactions/:id",
        { preHandler: [authenticate, requireRole("manager")] },
        async (request, reply) => {
            const { id } = request.params as { id: string };
            const body = request.body as {
                accountNumber: string;
                accountName: string;
                district: string;
                transactionType: "charge" | "payment";
                amount: number;
                description?: string | null;
            };

            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(id)) {
                return reply.code(400).send({ error: "Invalid transaction ID format" });
            }

            const { data, error } = await supabase
                .from("customer_transactions")
                .update({
                    account_number: body.accountNumber,
                    account_name: body.accountName,
                    district: body.district,
                    transaction_type: body.transactionType,
                    amount: body.amount,
                    description: body.description,
                })
                .eq("id", id)
                .select()
                .single();

            if (error) {
                console.error("Update transaction error:", error);
                return reply.code(500).send({ error: "Failed to update transaction" });
            }

            return reply.send(formatTransaction(data));
        }
    );
}

function formatTransaction(row: any) {
    return {
        id: row.id,
        recordedBy: row.recorded_by,
        accountNumber: row.account_number,
        accountName: row.account_name,
        district: row.district,
        transactionType: row.transaction_type,
        amount: Number(row.amount),
        description: row.description,
        referenceReportId: row.reference_report_id,
        createdAt: row.created_at,
    };
}
