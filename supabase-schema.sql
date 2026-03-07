-- =============================================
-- FieldWise Revenue Tracker — Supabase Schema
-- Run this in your Supabase SQL Editor
-- =============================================

-- 1. Profiles table (extends Supabase Auth users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('field_investigator', 'manager')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Investigation Reports table
CREATE TABLE IF NOT EXISTS investigation_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  officer_name TEXT NOT NULL,
  region TEXT NOT NULL,
  district TEXT NOT NULL,
  account_number TEXT NOT NULL,
  account_name TEXT NOT NULL,
  irregularities TEXT[] NOT NULL DEFAULT '{}',
  other_irregularity_details TEXT,
  ongoing_activity TEXT DEFAULT '',
  existing_service_category TEXT NOT NULL,
  action_taken TEXT NOT NULL,
  meter_replaced_or_new BOOLEAN NOT NULL DEFAULT FALSE,
  photo_url TEXT,
  latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_reports_user_id ON investigation_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_reports_district ON investigation_reports(district);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON investigation_reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_service_category ON investigation_reports(existing_service_category);

-- 4. Disable RLS (all access goes through the backend service-role key)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE investigation_reports ENABLE ROW LEVEL SECURITY;

-- Allow service role to bypass RLS (it does by default, but being explicit)
CREATE POLICY "Service role full access on profiles"
  ON profiles FOR ALL
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Service role full access on reports"
  ON investigation_reports FOR ALL
  USING (true)
  WITH CHECK (true);
