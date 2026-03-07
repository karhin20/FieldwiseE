import { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { supabase } from "../lib/supabase";
import { signupSchema, signinSchema } from "../schemas/auth";
import { authenticate } from "../middleware/auth";

const JWT_SECRET = process.env.JWT_SECRET || "";

export async function authRoutes(app: FastifyInstance) {
    /**
     * POST /api/auth/signup
     * Creates a Supabase Auth user + profiles row
     */
    app.post("/api/auth/signup", async (request, reply) => {
        // Validate input
        const parsed = signupSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "Validation failed",
                details: parsed.error.flatten().fieldErrors,
            });
        }

        const { email, password, fullName, role } = parsed.data;

        // Create user in Supabase Auth
        const { data: authData, error: authError } =
            await supabase.auth.admin.createUser({
                email,
                password,
                email_confirm: true, // auto-confirm for now
            });

        if (authError) {
            // Handle duplicate email
            if (authError.message.includes("already been registered")) {
                return reply.code(409).send({ error: "Email already registered" });
            }
            return reply.code(400).send({ error: authError.message });
        }

        const userId = authData.user.id;

        // Create profile row
        const { error: profileError } = await supabase.from("profiles").insert({
            id: userId,
            full_name: fullName,
            role,
        });

        if (profileError) {
            // Rollback: delete auth user if profile creation fails
            await supabase.auth.admin.deleteUser(userId);
            return reply.code(500).send({ error: "Failed to create user profile" });
        }

        return reply.code(201).send({
            message: "Account created successfully. Please sign in.",
        });
    });

    /**
     * POST /api/auth/signin
     * Authenticates with email/password, returns JWT
     */
    app.post("/api/auth/signin", async (request, reply) => {
        // Validate input
        const parsed = signinSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({
                error: "Validation failed",
                details: parsed.error.flatten().fieldErrors,
            });
        }

        const { email, password } = parsed.data;

        // Authenticate via Supabase Auth
        const { data: authData, error: authError } =
            await supabase.auth.signInWithPassword({ email, password });

        if (authError) {
            return reply.code(401).send({ error: "Invalid email or password" });
        }

        const userId = authData.user.id;

        // Fetch profile for role info
        const { data: profile, error: profileError } = await supabase
            .from("profiles")
            .select("full_name, role")
            .eq("id", userId)
            .single();

        if (profileError || !profile) {
            return reply.code(500).send({ error: "Failed to fetch user profile" });
        }

        // Sign our own JWT with user info
        const token = jwt.sign(
            {
                id: userId,
                email: authData.user.email,
                role: profile.role,
                fullName: profile.full_name,
            },
            JWT_SECRET,
            { expiresIn: "7d" }
        );

        return reply.send({
            token,
            user: {
                id: userId,
                email: authData.user.email,
                fullName: profile.full_name,
                role: profile.role,
            },
        });
    });

    /**
     * GET /api/auth/me
     * Returns the current authenticated user's profile
     */
    app.get(
        "/api/auth/me",
        { preHandler: [authenticate] },
        async (request, reply) => {
            const user = request.user!;

            // Fetch fresh profile data
            const { data: profile, error } = await supabase
                .from("profiles")
                .select("full_name, role")
                .eq("id", user.id)
                .single();

            if (error || !profile) {
                return reply.code(404).send({ error: "Profile not found" });
            }

            return reply.send({
                user: {
                    id: user.id,
                    email: user.email,
                    fullName: profile.full_name,
                    role: profile.role,
                },
            });
        }
    );
}
