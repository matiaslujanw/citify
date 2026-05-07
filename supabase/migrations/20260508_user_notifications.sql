-- ============================================================================
-- Bandeja de notificaciones por usuario (in-app).
-- Lo usa el propietario para enterarse de:
--   - "Te emitieron la liquidación de mayo"
--   - "Tu comprobante fue aprobado / rechazado"
-- En el futuro lo extendemos a otros eventos (recordatorios, anuncios, etc.).
-- ============================================================================

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_profile_id uuid not null references public.profiles(id) on delete cascade,
  kind text not null check (kind in (
    'liquidation_emitted',
    'payment_receipt_approved',
    'payment_receipt_rejected'
  )),
  title text not null,
  body text,
  link text,
  -- Referencias opcionales al objeto disparador, para deep-link y dedup.
  liquidation_run_id uuid references public.iadmin_liquidation_runs(id) on delete set null,
  liquidation_item_id uuid references public.iadmin_liquidation_items(id) on delete set null,
  payment_receipt_id uuid references public.iadmin_payment_receipts(id) on delete set null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists user_notifications_recipient_idx
  on public.user_notifications (recipient_profile_id, read_at, created_at desc);

create index if not exists user_notifications_unread_idx
  on public.user_notifications (recipient_profile_id)
  where read_at is null;

alter table public.user_notifications enable row level security;

-- Solo el destinatario puede ver y marcar como leídas sus notificaciones.
drop policy if exists "user_notifications self select" on public.user_notifications;
create policy "user_notifications self select" on public.user_notifications
  for select to authenticated
  using (recipient_profile_id = auth.uid());

drop policy if exists "user_notifications self update" on public.user_notifications;
create policy "user_notifications self update" on public.user_notifications
  for update to authenticated
  using (recipient_profile_id = auth.uid())
  with check (recipient_profile_id = auth.uid());

-- Las inserts las hace el server (server actions usando service role o RLS de
-- la administración correspondiente). Por simplicidad, permitimos a
-- authenticated insertar para sus eventos relevantes — los server actions
-- validan los permisos antes de invocar este insert.
drop policy if exists "user_notifications insert by admin" on public.user_notifications;
create policy "user_notifications insert by admin" on public.user_notifications
  for insert to authenticated
  with check (
    -- El que dispara la notificación es el admin del consorcio asociado al
    -- liquidation_run o el dueño de la cuenta (caso aprobaciones que el server
    -- hace en nombre del admin). En la práctica los server actions corren con
    -- la sesión del admin, así que validamos contra su pertenencia.
    (
      liquidation_run_id is not null and exists (
        select 1
        from public.iadmin_liquidation_runs lr
        where lr.id = liquidation_run_id
          and public.iadmin_user_belongs_to(lr.administration_id)
      )
    )
    or (
      payment_receipt_id is not null and exists (
        select 1
        from public.iadmin_payment_receipts pr
        join public.iadmin_liquidation_items li on li.id = pr.liquidation_item_id
        join public.iadmin_liquidation_runs lr on lr.id = li.liquidation_run_id
        where pr.id = payment_receipt_id
          and public.iadmin_user_belongs_to(lr.administration_id)
      )
    )
  );
