ALTER TABLE documents ADD COLUMN citekey TEXT;
CREATE UNIQUE INDEX uq_documents_citekey ON documents(citekey) WHERE citekey IS NOT NULL;
