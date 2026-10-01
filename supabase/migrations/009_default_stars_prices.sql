update public.telegram_plans set stars_price=50,updated_at=now() where code='basic';
update public.telegram_plans set stars_price=100,updated_at=now() where code='pro';