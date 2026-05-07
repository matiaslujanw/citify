-- IAdmin: facturas recurrentes + recordatorios automaticos
-- Idempotente. Aditiva.

-- ----------------------------------------------------------------------------
-- 1. Facturas recurrentes: flag + monto tipico en iadmin_providers
-- ----------------------------------------------------------------------------
alter table public.iadmin_providers
  add column if not exists is_recurring boolean not null default false,
  add column if not exists recurring_amount numeric(14,2),
  add column if not exists recurring_kind public.iadmin_expense_kind not null default 'ordinaria';

create index if not exists iadmin_providers_recurring_idx
  on public.iadmin_providers (administration_id) where is_recurring = true;

-- ----------------------------------------------------------------------------
-- 2. Recordatorios
-- ----------------------------------------------------------------------------
create table if not exists public.iadmin_reminders (
  id uuid primary key default gen_random_uuid(),
  administration_id uuid not null references public.iadmin_administrations(id) on delete cascade,
  managed_property_id uuid references public.iadmin_managed_properties(id) on delete cascade,
  liquidation_item_id uuid not null references public.iadmin_liquidation_items(id) on delete cascade,
  reminder_kind text not null check (reminder_kind in ('pre_due', 'overdue_first', 'overdue_second', 'overdue_heavy')),
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed')),
  message_body text,
  amount_due numeric(14,2),
  due_label text,
  due_date date,
  generated_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_by uuid references public.profiles(id) on delete set null,
  dismissed_at timestamptz,
  dismissed_by uuid references public.profiles(id) on delete set null,
  notes text
);

-- Columna generada con la fecha (en UTC, expresion IMMUTABLE) para poder
-- usarla en un índice único sin que postgres se queje por timezone.
alter table public.iadmin_reminders
  add column if not exists generated_on date
    generated always as (((generated_at) at time zone 'UTC')::date) stored;

-- Evitar duplicar el mismo recordatorio el mismo dia para el mismo item
create unique index if not exists iadmin_reminders_daily_unique
  on public.iadmin_reminders (liquidation_item_id, reminder_kind, generated_on);

create index if not exists iadmin_reminders_admin_status_idx
  on public.iadmin_reminders (administration_id, status);
create index if not exists iadmin_reminders_property_status_idx
  on public.iadmin_reminders (managed_property_id, status);

alter table public.iadmin_reminders enable row level security;

drop policy if exists "iadmin_reminders select" on public.iadmin_reminders;
create policy "iadmin_reminders select" on public.iadmin_reminders
  for select to authenticated
  using (public.iadmin_user_belongs_to(administration_id));

drop policy if exists "iadmin_reminders write" on public.iadmin_reminders;
create policy "iadmin_reminders write" on public.iadmin_reminders
  for all to authenticated
  using (public.iadmin_user_belongs_to(administration_id))
  with check (public.iadmin_user_belongs_to(administration_id));

-- ----------------------------------------------------------------------------
-- 3. Capacidades nuevas
-- ----------------------------------------------------------------------------
insert into public.iadmin_capabilities (code, description) values
  ('expenses.recurring.manage', 'Marcar proveedores como recurrentes y clonar gastos'),
  ('reminders.generate',        'Generar recordatorios automaticos'),
  ('reminders.send',            'Marcar recordatorios como enviados')
on conflict (code) do update set description = excluded.description;
