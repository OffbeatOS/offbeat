-- Stream is on by default for Members: existing Members get it too. Admins have every permission already.
UPDATE `users` SET `permissions` = json_insert(`permissions`, '$[#]', 'stream') WHERE `role` = 'user' AND json_valid(`permissions`) AND NOT EXISTS (SELECT 1 FROM json_each(`users`.`permissions`) WHERE `value` = 'stream');
