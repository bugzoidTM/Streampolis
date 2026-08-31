-- 0005_seed.sql — catálogos e flags iniciais. Idempotente (ON CONFLICT DO UPDATE).
-- O catálogo de gifts/itens do servidor é a autoridade de preço; o cliente só
-- desenha (SPECs §68 regra 1/6).

INSERT INTO streampolis.feature_flags (key, enabled, description) VALUES
  ('real_payments',    FALSE, 'Habilita provider de pagamento real (Pix/cartão). Default DESLIGADO (§64).'),
  ('pk_enabled',       TRUE,  'PK Arena e batalhas PK.'),
  ('agencies_enabled', TRUE,  'Criação e gestão de agências.'),
  ('voice_enabled',    FALSE, 'Voz nas lives (§49, futuro).'),
  ('creator_program',  FALSE, 'Programa de criadores / conversão de Creator Points (PRD §16).'),
  ('gift_catalog_v2',  FALSE, 'Segunda versão do catálogo de presentes.')
ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO streampolis.coin_packages (id, name, coins, bonus_coins, price_cents, currency, sort_order, active) VALUES
  ('pk_100',    'Punhado de Coins', 100,     0, 990,    'BRL', 1, TRUE),
  ('pk_550',    'Bolso Cheio',      500,    50, 4490,   'BRL', 2, TRUE),
  ('pk_1200',   'Mala de Coins',   1000,   200, 8990,   'BRL', 3, TRUE),
  ('pk_3500',   'Cofre',           3000,   500, 24990,  'BRL', 4, TRUE),
  ('pk_12000',  'Fortuna',        10000,  2000, 79990,  'BRL', 5, TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, coins = EXCLUDED.coins, bonus_coins = EXCLUDED.bonus_coins,
  price_cents = EXCLUDED.price_cents, active = EXCLUDED.active;

INSERT INTO streampolis.gift_catalog (id, name, category, coin_cost, creator_points, pk_points, animation_id, rarity, catalog_version, active) VALUES
  ('g_rose',    'Rosa',     'basic',      1,     1,     1, 'fx_rose',    'common',    1, TRUE),
  ('g_coffee',  'Café',     'basic',      5,     5,     5, 'fx_coffee',  'common',    1, TRUE),
  ('g_heart',   'Coração',  'social',    20,    20,    20, 'fx_heart',   'common',    1, TRUE),
  ('g_star',    'Estrela',  'social',    99,    99,    99, 'fx_star',    'rare',      1, TRUE),
  ('g_diamond', 'Diamante', 'premium',  499,   499,   499, 'fx_diamond', 'epic',      1, TRUE),
  ('g_crown',   'Coroa',    'premium', 1999,  1999,  1999, 'fx_crown',   'legendary', 1, TRUE),
  ('g_rocket',  'Rocket',   'spectacle',9999, 9999,  9999, 'fx_rocket',  'mythic',    1, TRUE)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, coin_cost = EXCLUDED.coin_cost,
  creator_points = EXCLUDED.creator_points, pk_points = EXCLUDED.pk_points,
  rarity = EXCLUDED.rarity, active = EXCLUDED.active;

INSERT INTO streampolis.items (id, type, name, rarity, credits_price, coins_price, asset_id, footprint_x, footprint_y, active) VALUES
  ('hair_bob_01', 'hair', 'Bob Curto', 'common', 0, NULL, 'hair_bob_01', NULL, NULL, true),
  ('hair_ponytail_01', 'hair', 'Rabo de Cavalo', 'common', 240, NULL, 'hair_ponytail_01', NULL, NULL, true),
  ('hair_afro_01', 'hair', 'Afro', 'common', 240, NULL, 'hair_afro_01', NULL, NULL, true),
  ('hair_buzz_01', 'hair', 'Raspado', 'common', 0, NULL, 'hair_buzz_01', NULL, NULL, true),
  ('hair_long_01', 'hair', 'Longo Liso', 'rare', 680, NULL, 'hair_long_01', NULL, NULL, true),
  ('hair_braids_01', 'hair', 'Tranças', 'rare', 680, NULL, 'hair_braids_01', NULL, NULL, true),
  ('hair_mohawk_01', 'hair', 'Moicano Neon', 'epic', NULL, 320, 'hair_mohawk_01', NULL, NULL, true),
  ('top_tee_01', 'top', 'Camiseta Lisa', 'common', 0, NULL, 'top_tee_01', NULL, NULL, true),
  ('top_hoodie_01', 'top', 'Moletom', 'common', 320, NULL, 'top_hoodie_01', NULL, NULL, true),
  ('top_jacket_01', 'top', 'Jaqueta Bomber', 'rare', 890, NULL, 'top_jacket_01', NULL, NULL, true),
  ('top_blazer_01', 'top', 'Blazer', 'rare', 890, NULL, 'top_blazer_01', NULL, NULL, true),
  ('top_holo_01', 'top', 'Top Holográfico', 'epic', NULL, 480, 'top_holo_01', NULL, NULL, true),
  ('bottom_jeans_01', 'bottom', 'Jeans', 'common', 0, NULL, 'bottom_jeans_01', NULL, NULL, true),
  ('bottom_cargo_01', 'bottom', 'Cargo', 'common', 280, NULL, 'bottom_cargo_01', NULL, NULL, true),
  ('bottom_skirt_01', 'bottom', 'Saia Plissada', 'common', 280, NULL, 'bottom_skirt_01', NULL, NULL, true),
  ('bottom_track_01', 'bottom', 'Calça Track', 'rare', 620, NULL, 'bottom_track_01', NULL, NULL, true),
  ('shoes_sneaker_01', 'shoes', 'Tênis Básico', 'common', 0, NULL, 'shoes_sneaker_01', NULL, NULL, true),
  ('shoes_boot_01', 'shoes', 'Coturno', 'common', 340, NULL, 'shoes_boot_01', NULL, NULL, true),
  ('shoes_glow_01', 'shoes', 'Tênis Glow', 'epic', NULL, 260, 'shoes_glow_01', NULL, NULL, true),
  ('acc_glasses_01', 'accessory', 'Óculos', 'common', 180, NULL, 'acc_glasses_01', NULL, NULL, true),
  ('acc_cap_01', 'accessory', 'Boné', 'common', 180, NULL, 'acc_cap_01', NULL, NULL, true),
  ('acc_headset_01', 'accessory', 'Headset', 'rare', 540, NULL, 'acc_headset_01', NULL, NULL, true),
  ('acc_halo_01', 'accessory', 'Halo', 'legendary', NULL, 1200, 'acc_halo_01', NULL, NULL, true),
  ('fur_sofa_01', 'furniture', 'Sofá Modular', 'common', 900, NULL, 'fur_sofa_01', 3, 2, true),
  ('fur_chair_01', 'furniture', 'Poltrona', 'common', 420, NULL, 'fur_chair_01', 1, 1, true),
  ('fur_table_01', 'furniture', 'Mesa de Centro', 'common', 380, NULL, 'fur_table_01', 2, 1, true),
  ('fur_bed_01', 'furniture', 'Cama', 'common', 1200, NULL, 'fur_bed_01', 2, 3, true),
  ('fur_rug_01', 'furniture', 'Tapete', 'common', 260, NULL, 'fur_rug_01', 3, 2, true),
  ('fur_plant_01', 'furniture', 'Planta', 'common', 190, NULL, 'fur_plant_01', 1, 1, true),
  ('fur_shelf_01', 'furniture', 'Estante', 'common', 640, NULL, 'fur_shelf_01', 2, 1, true),
  ('fur_lamp_01', 'furniture', 'Luminária', 'common', 220, NULL, 'fur_lamp_01', 1, 1, true),
  ('fur_desk_01', 'furniture', 'Mesa de Setup', 'rare', 1400, NULL, 'fur_desk_01', 2, 1, true),
  ('fur_neon_01', 'furniture', 'Neon de Parede', 'rare', NULL, 180, 'fur_neon_01', 2, 1, true),
  ('gear_ring_01', 'stream_gear', 'Ring Light', 'rare', 1600, NULL, 'gear_ring_01', 1, 1, true),
  ('gear_backdrop_01', 'stream_gear', 'Backdrop LED', 'epic', NULL, 640, 'gear_backdrop_01', 4, 1, true),
  ('floor_wood_01', 'floor', 'Piso Madeira', 'common', 0, NULL, 'floor_wood_01', NULL, NULL, true),
  ('floor_tile_01', 'floor', 'Piso Cerâmica', 'common', 300, NULL, 'floor_tile_01', NULL, NULL, true),
  ('floor_carpet_01', 'floor', 'Carpete', 'common', 300, NULL, 'floor_carpet_01', NULL, NULL, true),
  ('wall_paint_01', 'wall', 'Parede Pintada', 'common', 0, NULL, 'wall_paint_01', NULL, NULL, true),
  ('wall_brick_01', 'wall', 'Tijolo Aparente', 'common', 340, NULL, 'wall_brick_01', NULL, NULL, true),
  ('wall_panel_01', 'wall', 'Painel Ripado', 'rare', 720, NULL, 'wall_panel_01', NULL, NULL, true)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name, rarity = EXCLUDED.rarity,
  credits_price = EXCLUDED.credits_price, coins_price = EXCLUDED.coins_price,
  active = EXCLUDED.active;
