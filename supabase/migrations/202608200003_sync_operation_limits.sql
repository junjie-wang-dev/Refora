update refora_sync.operations
set result = result - 'payload'
where result ->> 'status' = 'conflict';

update refora_sync.operations
set expires_at = least(expires_at, created_at + interval '1 day');

delete from refora_sync.operations
where expires_at < now();

alter table refora_sync.operations
alter column expires_at set default now() + interval '1 day';

alter table refora_sync.operations
add constraint sync_operations_result_size_valid
check (octet_length(result::text) <= 4096);

create index sync_operations_user_expiry_idx
on refora_sync.operations(user_id, expires_at);

create or replace function refora_sync.prepare_operation_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.result ->> 'status' = 'conflict' then
    new.result := new.result - 'payload';
  end if;
  new.expires_at := least(new.expires_at, new.created_at + interval '1 day');
  if octet_length(new.result::text) > 4096 then
    raise exception 'Operation result is too large' using errcode = '54000';
  end if;
  return new;
end;
$$;

revoke all on function refora_sync.prepare_operation_record() from public, anon, authenticated;

create trigger sync_operations_prepare_record
before insert or update on refora_sync.operations
for each row execute function refora_sync.prepare_operation_record();

alter function public.refora_sync_push(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) rename to refora_sync_push_v2_internal;

revoke all on function public.refora_sync_push_v2_internal(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) from public, anon, authenticated;

create function public.refora_sync_push(
  p_library_id uuid,
  p_device_id uuid,
  p_operation_id uuid,
  p_entity_type text,
  p_entity_id text,
  p_base_version bigint,
  p_deleted boolean,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '28000';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text || '|sync-quota', 0)
  );

  delete from refora_sync.operations
  where user_id = v_user_id and expires_at < now();

  if not exists (
    select 1
    from refora_sync.operations
    where user_id = v_user_id and operation_id = p_operation_id
  ) and (
    select count(*)
    from refora_sync.operations
    where user_id = v_user_id
  ) >= 20000 then
    raise exception 'Account sync operation quota exceeded' using errcode = '54000';
  end if;

  perform public.refora_sync_push_v2_internal(
    p_library_id,
    p_device_id,
    p_operation_id,
    p_entity_type,
    p_entity_id,
    p_base_version,
    p_deleted,
    p_payload
  );

  select result into v_result
  from refora_sync.operations
  where user_id = v_user_id and operation_id = p_operation_id;

  if v_result is null then
    raise exception 'Sync operation result is missing' using errcode = '55000';
  end if;

  return v_result;
end;
$$;

revoke all on function public.refora_sync_push(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) from public, anon;

grant execute on function public.refora_sync_push(
  uuid,
  uuid,
  uuid,
  text,
  text,
  bigint,
  boolean,
  jsonb
) to authenticated;
