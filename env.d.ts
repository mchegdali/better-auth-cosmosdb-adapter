declare namespace NodeJS {
  interface ProcessEnv {
    COSMOS_DB_ENDPOINT: string;
    COSMOS_DB_KEY: string;
    COSMOS_DB_DATABASE_NAME: string;
  }
}
