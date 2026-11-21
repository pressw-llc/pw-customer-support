DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_project_id_uq'
      AND conrelid = 'support.customers'::regclass
  ) THEN
    ALTER TABLE support.customers
      ADD CONSTRAINT customers_project_id_uq UNIQUE (project_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'requests_customer_project_fk'
      AND conrelid = 'support.requests'::regclass
  ) THEN
    ALTER TABLE support.requests
      ADD CONSTRAINT requests_customer_project_fk
      FOREIGN KEY (project_id, customer_id)
      REFERENCES support.customers (project_id, id)
      ON DELETE CASCADE;
  END IF;
END $$;
