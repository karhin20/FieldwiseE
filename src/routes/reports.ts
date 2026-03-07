import { FastifyInstance } from "fastify";
import { supabase } from "../lib/supabase";
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

            let dbQuery = supabase
                .from("investigation_reports")
                .select("*", { count: "exact" })
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

            if (error) {
                console.error("Reports fetch error:", error);
                return reply.code(500).send({ error: "Failed to fetch reports" });
            }

            return reply.send({
                reports: (reports || []).map(formatReport),
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

            let dbQuery = supabase
                .from("investigation_reports")
                .select("region, district, officer_name, irregularities, existing_service_category, meter_replaced_or_new, action_taken, created_at, latitude, longitude");

            // Role-based scoping
            if (user.role === "field_investigator") {
                dbQuery = dbQuery.eq("user_id", user.id);
            }

            // Apply Filters
            if (query.district && query.district !== "all") dbQuery = dbQuery.eq("district", query.district);
            if (query.officer && query.officer !== "all") dbQuery = dbQuery.eq("officer_name", query.officer);
            if (query.category && query.category !== "all") dbQuery = dbQuery.eq("existing_service_category", query.category);
            if (query.irregularity && query.irregularity !== "all") dbQuery = dbQuery.contains("irregularities", [query.irregularity]);

            if (query.dateFrom) {
                dbQuery = dbQuery.gte("created_at", query.dateFrom);
            }
            if (query.dateTo) {
                // Ensure dateTo includes the whole day
                const end = new Date(query.dateTo);
                end.setUTCHours(23, 59, 59, 999);
                dbQuery = dbQuery.lte("created_at", end.toISOString());
            }

            const { data: reports, error } = await dbQuery;

            if (error) {
                console.error("Stats fetch error:", error);
                return reply.code(500).send({ error: "Failed to fetch stats" });
            }

            if (!reports || reports.length === 0) {
                return reply.send({
                    totalReports: 0,
                    activeRegions: 0,
                    topIrregularity: null,
                    pieData: [],
                    barData: [],
                    categoryData: [],
                    trendData: [],
                    stackedData: [],
                    officerLeaderboard: [],
                    kpis: {
                        totalIrregularities: 0,
                        metersReplaced: 0,
                        replacementRate: 0,
                        avgIrrPerReport: "0",
                        escalatedCases: 0,
                        topDistrict: "—"
                    }
                });
            }

            // Aggregations
            const uniqueRegions = new Set(reports.map(r => r.region).filter(Boolean));
            const districtCounts: Record<string, number> = {};
            const irregularityCounts: Record<string, number> = {};
            const categoryCounts: Record<string, number> = {};
            const officerStats: Record<string, { reports: number; irregularities: number; metersReplaced: number }> = {};
            const trendMap: Record<string, number> = {};
            const irrByDistrict: Record<string, Record<string, number>> = {};
            const hotspots: Array<{ lat: number; lng: number; hasIrregularity: boolean }> = [];

            let metersReplaced = 0;
            let escalatedCases = 0;

            reports.forEach(r => {
                // Districts
                districtCounts[r.district] = (districtCounts[r.district] || 0) + 1;

                // Categories
                categoryCounts[r.existing_service_category] = (categoryCounts[r.existing_service_category] || 0) + 1;

                // Irregularities
                if (Array.isArray(r.irregularities)) {
                    r.irregularities.forEach((irr: string) => {
                        irregularityCounts[irr] = (irregularityCounts[irr] || 0) + 1;

                        if (!irrByDistrict[r.district]) irrByDistrict[r.district] = {};
                        irrByDistrict[r.district][irr] = (irrByDistrict[r.district][irr] || 0) + 1;
                    });
                }

                // Officers
                if (!officerStats[r.officer_name]) {
                    officerStats[r.officer_name] = { reports: 0, irregularities: 0, metersReplaced: 0 };
                }
                officerStats[r.officer_name].reports += 1;
                officerStats[r.officer_name].irregularities += (r.irregularities?.length || 0);
                if (r.meter_replaced_or_new) {
                    officerStats[r.officer_name].metersReplaced += 1;
                    metersReplaced += 1;
                }

                // KPIs
                if (r.action_taken?.toLowerCase().includes("escalat")) escalatedCases += 1;

                // Trend (group by day like Dec 1)
                const date = new Date(r.created_at);
                const dayKey = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                trendMap[dayKey] = (trendMap[dayKey] || 0) + 1;

                // Hotspots
                if (r.latitude && r.longitude) {
                    hotspots.push({
                        lat: r.latitude,
                        lng: r.longitude,
                        hasIrregularity: (r.irregularities?.length || 0) > 0
                    });
                }
            });

            // Format Pie Data
            const pieData = Object.entries(irregularityCounts)
                .map(([name, value]) => ({ name, value }))
                .sort((a, b) => b.value - a.value);

            // Format Bar Data
            const barData = Object.entries(districtCounts)
                .map(([name, count]) => ({ name, count }))
                .sort((a, b) => b.count - a.count);

            // Format Category Data
            const categoryData = Object.entries(categoryCounts)
                .map(([name, value]) => ({ name, value }))
                .sort((a, b) => b.value - a.value);

            // Format Officer Leaderboard
            const officerLeaderboard = Object.entries(officerStats)
                .map(([name, s]) => ({ name, ...s }))
                .sort((a, b) => b.reports - a.reports);

            // Format Trend Data (last 14 days)
            const trendData = Object.entries(trendMap)
                .map(([date, count]) => ({ date, count }))
                .slice(-14);

            // Format Stacked Data
            const topIrrTypes = pieData.slice(0, 5).map(p => p.name);
            const stackedData = Object.entries(irrByDistrict).map(([district, irrs]) => ({
                district: district.replace("Accra ", ""),
                ...irrs,
            }));

            const totalIrregularities = Object.values(irregularityCounts).reduce((a, b) => a + b, 0);

            return reply.send({
                totalReports: reports.length,
                activeRegions: uniqueRegions.size,
                topIrregularity: pieData[0]?.name || null,
                pieData,
                barData,
                categoryData,
                trendData,
                stackedData,
                officerLeaderboard,
                hotspots,
                kpis: {
                    totalIrregularities,
                    metersReplaced,
                    replacementRate: Math.round((metersReplaced / reports.length) * 100),
                    avgIrrPerReport: (totalIrregularities / reports.length).toFixed(1),
                    escalatedCases,
                    topDistrict: barData[0]?.name ?? "—"
                }
            });
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

            // If photo changed and old one was a storage path, delete old file
            if (existing.photo_url && data.photoUrl !== existing.photo_url) {
                const oldPath = existing.photo_url;
                if (oldPath && !oldPath.startsWith("data:") && !oldPath.startsWith("http") && oldPath.length < 500) {
                    await supabase.storage.from("investigation-photos").remove([oldPath]);
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

            // Delete associated photo from storage
            if (existing.photo_url && !existing.photo_url.startsWith("data:") && !existing.photo_url.startsWith("http") && existing.photo_url.length < 500) {
                await supabase.storage.from("investigation-photos").remove([existing.photo_url]);
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
