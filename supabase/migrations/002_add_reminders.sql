-- ============================================================
-- Barber Agent — Migración 002: sistema de recordatorios
-- Ejecutar en Supabase SQL Editor después de 001_initial_schema.sql
-- ============================================================

-- Agrega un array que registra qué recordatorios ya se enviaron por cita.
-- Valores posibles en el array: "2h", "30m"
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS reminders_sent TEXT[] NOT NULL DEFAULT '{}';
