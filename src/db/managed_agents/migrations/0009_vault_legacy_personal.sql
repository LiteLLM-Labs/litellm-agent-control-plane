UPDATE "LiteLLM_CredentialsTable"
SET scope = 'personal',
    owner_id = split_part(credential_name, ':', 2)
WHERE credential_name LIKE 'vault:%'
  AND scope = 'global';
