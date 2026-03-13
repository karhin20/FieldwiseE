import { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase";
import cloudinary from "../lib/cloudinary";
import { createReportSchema } from "../schemas/reports";
import { authenticate, requireRole } from "../middleware/auth";

export async function reportRoutes(app: FastifyInstance) {
    /**
     * POST /api/reports
     * Workers submit a new investigation report.
     * Officer name is auto-set from the authenticated user's profile.
     */
    app.post(
        "/api/reports",
        { preHandler: [authenticate, requireRole("field_investigator")] },
        async (request, reply) => {
            const user = request.user!;

            // Validate input
            const parsed = createReportSchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.code(400).send({
                    error: "Validation failed",
                    details: parsed.error.flatten().fieldErrors,
                });
            }

            const data = parsed.data;

            const { data: report, error } = await supabase
                .from("investigation_reports")
                .insert({
                    user_id: user.id,
                    officer_name: user.fullName, // auto from auth, not user input
                    region: data.region,
                    district: data.district,
                    account_number: data.accountNumber,
                    account_name: data.accountName,
                    irregularities: data.irregularities,
                    other_irregularity_details: data.otherIrregularityDetails || null,
                    ongoing_activity: data.ongoingActivity,
                    existing_service_category: data.existingServiceCategory,
                    action_taken: data.actionTaken,
                    meter_replaced_or_new: data.meterReplacedOrNew,
                    photo_url: data.photoUrl || null,
                    latitude: data.latitude,
                    longitude: data.longitude,
                })
                .select()
                .single();

            if (error) {
                console.error("Report creation error:", error);
                return reply.code(500).send({ error: "Failed to create report" });
            }

            return reply.code(201).send({ report: formatReport(report) });
        }
    );

    /**
     * GET /api/reports
     * Workers see their own reports; managers see all reports.
     * Supports pagination via ?page=1&limit=50
     * Supports photo filtering via ?hasPhoto=true
     */
    app.get(
        "/api/reports",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const query = request.query as { page?: string; limit?: string; hasPhoto?: string };

            const page = Math.max(1, parseInt(query.page || "1", 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(query.limit || "50", 10) || 50));
            const offset = (page - 1) * limit;

            // Optimized query: Select report fields and aggregate transaction sums
            // Using a subquery for transactions to keep it efficient and avoid complex joins in the main select
            let dbQuery = supabase
                .from("investigation_reports")
                .select(
                    `
                    id, 
                    account_name, 
                    account_number, 
                    existing_service_category, 
                    irregularities, 
                    officer_name, 
                    district, 
                    created_at, 
                    action_taken, 
                    meter_replaced_or_new, 
                    photo_url,
                    customer_transactions(amount, transaction_type)
                    `,
                    { count: "exact" }
                )
                .order("created_at", { ascending: false })
                .range(offset, offset + limit - 1);

            // Field investigators only see their own reports
            if (user.role === "field_investigator") {
                dbQuery = dbQuery.eq("user_id", user.id);
            }

            // Filter for reports with photos
            if (query.hasPhoto === "true") {
                dbQuery = dbQuery.not("photo_url", "is", null);
            }

            const { data: reports, error, count } = await dbQuery;

            const formattedReports = (reports || []).map((r: any) => {
                const transactions = r.customer_transactions || [];
                const totalCharges = transactions
                    .filter((t: any) => t.transaction_type === "charge")
                    .reduce((sum: number, t: any) => sum + Number(t.amount), 0);
                const totalPayments = transactions
                    .filter((t: any) => t.transaction_type === "payment")
                    .reduce((sum: number, t: any) => sum + Number(t.amount), 0);

                const report = formatReport(r);
                return {
                    ...report,
                    totalFunds: totalCharges - totalPayments,
                    hasFunds: transactions.length > 0
                };
            });

            // Handle memory-based filtering for hasFunds since Supabase grouping/filtering on joined counts is tricky
            // For production, we'd use an RPC or a database view for even better performance
            let finalReports = formattedReports;
            const hasFundsQuery = request.query as { hasFunds?: string };
            if (hasFundsQuery.hasFunds === "true") {
                finalReports = formattedReports.filter(r => r.hasFunds);
            } else if (hasFundsQuery.hasFunds === "false") {
                finalReports = formattedReports.filter(r => !r.hasFunds);
            }

            return reply.send({
                reports: finalReports,
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
     * GET /api/reports/stats
     * Returns aggregated statistics for the dashboard.
     */
    app.get(
        "/api/reports/stats",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const query = request.query as {
                district?: string;
                officer?: string;
                category?: string;
                irregularity?: string;
                dateFrom?: string;
                dateTo?: string;
            };

            // Fix dateTo to included the full day
            let dateToFormatted = query.dateTo || null;
            if (dateToFormatted) {
                const end = new Date(dateToFormatted);
                end.setUTCHours(23, 59, 59, 999);
                dateToFormatted = end.toISOString();
            }

            // Call the optimized Postgres function
            const { data: stats, error } = await supabase.rpc("get_dashboard_stats", {
                p_user_role: user.role,
                p_user_id: user.id,
                p_district: query.district || "all",
                p_officer: query.officer || "all",
                p_category: query.category || "all",
                p_irregularity: query.irregularity || "all",
                p_date_from: query.dateFrom || null,
                p_date_to: dateToFormatted,
            });

            if (error) {
                console.error("Stats RPC error:", error);
                return reply.code(500).send({ error: "Failed to calculate statistics" });
            }

            return reply.send(stats);
        }
    );

    /**
     * GET /api/reports/:id
     * Get a single report by ID.
     * Workers can only view their own; managers can view any.
     */
    app.get(
        "/api/reports/:id",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;
            const { id } = request.params as { id: string };

            // Basic UUID format validation
            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(id)) {
                return reply.code(400).send({ error: "Invalid report ID format" });
            }

            let dbQuery = supabase
                .from("investigation_reports")
                .select("*")
                .eq("id", id);

            // Field investigators can only see their own
            if (user.role === "field_investigator") {
                dbQuery = dbQuery.eq("user_id", user.id);
            }

            const { data: report, error } = await dbQuery.single();

            if (error || !report) {
                return reply.code(404).send({ error: "Report not found" });
            }

            return reply.send({ report: formatReport(report) });
        }
    );

    /**
     * PUT /api/reports/:id
     * Field investigators can update their own report — only before midnight GMT of the next day.
     */
    app.put(
        "/api/reports/:id",
        { preHandler: [authenticate, requireRole("field_investigator")] },
        async (request, reply) => {
            const user = request.user!;
            const { id } = request.params as { id: string };

            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(id)) {
                return reply.code(400).send({ error: "Invalid report ID format" });
            }

            // Fetch the existing report
            const { data: existing, error: fetchErr } = await supabase
                .from("investigation_reports")
                .select("*")
                .eq("id", id)
                .eq("user_id", user.id)
                .single();

            if (fetchErr || !existing) {
                return reply.code(404).send({ error: "Report not found" });
            }

            // Check midnight GMT cutoff
            if (!isWithinEditWindow(existing.created_at)) {
                return reply.code(403).send({ error: "Edit window has expired" });
            }

            // Validate input
            const parsed = createReportSchema.safeParse(request.body);
            if (!parsed.success) {
                return reply.code(400).send({
                    error: "Validation failed",
                    details: parsed.error.flatten().fieldErrors,
                });
            }

            const data = parsed.data;

            // If photo changed and old one was a storage path, delete old file from Cloudinary
            if (existing.photo_url && data.photoUrl !== existing.photo_url) {
                const oldPath = existing.photo_url;
                if (oldPath && !oldPath.startsWith("http") && !oldPath.startsWith("data:") && oldPath.includes("/")) {
                    try {
                        await cloudinary.uploader.destroy(oldPath);
                    } catch (err) {
                        console.error("Cleanup error (Cloudinary):", err);
                    }
                }
            }

            const { data: updated, error: updateErr } = await supabase
                .from("investigation_reports")
                .update({
                    region: data.region,
                    district: data.district,
                    account_number: data.accountNumber,
                    account_name: data.accountName,
                    irregularities: data.irregularities,
                    other_irregularity_details: data.otherIrregularityDetails || null,
                    ongoing_activity: data.ongoingActivity,
                    existing_service_category: data.existingServiceCategory,
                    action_taken: data.actionTaken,
                    meter_replaced_or_new: data.meterReplacedOrNew,
                    photo_url: data.photoUrl || null,
                    latitude: data.latitude,
                    longitude: data.longitude,
                })
                .eq("id", id)
                .eq("user_id", user.id)
                .select()
                .single();

            if (updateErr) {
                console.error("Report update error:", updateErr);
                return reply.code(500).send({ error: "Failed to update report" });
            }

            return reply.send({ report: formatReport(updated) });
        }
    );

    /**
     * DELETE /api/reports/:id
     * Field investigators can delete their own report — only before midnight GMT of the next day.
     */
    app.delete(
        "/api/reports/:id",
        { preHandler: [authenticate, requireRole("field_investigator")] },
        async (request, reply) => {
            const user = request.user!;
            const { id } = request.params as { id: string };

            const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!uuidRegex.test(id)) {
                return reply.code(400).send({ error: "Invalid report ID format" });
            }

            // Fetch the existing report
            const { data: existing, error: fetchErr } = await supabase
                .from("investigation_reports")
                .select("*")
                .eq("id", id)
                .eq("user_id", user.id)
                .single();

            if (fetchErr || !existing) {
                return reply.code(404).send({ error: "Report not found" });
            }

            // Check midnight GMT cutoff
            if (!isWithinEditWindow(existing.created_at)) {
                return reply.code(403).send({ error: "Edit window has expired" });
            }

            // Delete associated photo from Cloudinary
            if (existing.photo_url && !existing.photo_url.startsWith("http") && !existing.photo_url.startsWith("data:") && existing.photo_url.includes("/")) {
                try {
                    await cloudinary.uploader.destroy(existing.photo_url);
                } catch (err) {
                    console.error("Cleanup error on delete (Cloudinary):", err);
                }
            }

            const { error: deleteErr } = await supabase
                .from("investigation_reports")
                .delete()
                .eq("id", id)
                .eq("user_id", user.id);

            if (deleteErr) {
                console.error("Report delete error:", deleteErr);
                return reply.code(500).send({ error: "Failed to delete report" });
            }

            return reply.send({ message: "Report deleted successfully" });
        }
    );
}

/**
 * Check if a report is still within the edit/delete window.
 * Window closes at midnight GMT on the day AFTER creation.
 * e.g. created March 6 at any time → editable until March 7 00:00:00 GMT
 */
function isWithinEditWindow(createdAt: string): boolean {
    const created = new Date(createdAt);
    // Get the start of the next day in UTC
    const cutoff = new Date(Date.UTC(
        created.getUTCFullYear(),
        created.getUTCMonth(),
        created.getUTCDate() + 1, // next day
        0, 0, 0, 0 // midnight
    ));
    return new Date() < cutoff;
}

/**
 * Transform DB row (snake_case) → API response (camelCase)
 * matching the frontend InvestigationReport interface
 */
function formatReport(row: any) {
    return {
        id: row.id,
        officerName: row.officer_name,
        region: row.region,
        district: row.district,
        accountNumber: row.account_number,
        accountName: row.account_name,
        irregularities: row.irregularities || [],
        otherIrregularityDetails: row.other_irregularity_details,
        ongoingActivity: row.ongoing_activity,
        existingServiceCategory: row.existing_service_category,
        actionTaken: row.action_taken,
        meterReplacedOrNew: row.meter_replaced_or_new,
        photoUrl: row.photo_url,
        location: row.latitude != null && row.longitude != null
            ? { lat: row.latitude, lng: row.longitude }
            : null,
        createdAt: row.created_at,
        userId: row.user_id,
    };
}
