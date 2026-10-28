import pg from "pg";

export interface SqlQueryResult<Row> {
  readonly rows: readonly Row[];
  readonly rowCount: number;
}

export interface SqlExecutor {
  query<Row extends Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<SqlQueryResult<Row>>;
}

export interface SqlDatabase extends SqlExecutor {
  transaction<T>(work: (transaction: SqlExecutor) => Promise<T>): Promise<T>;
}

export class PgDatabase implements SqlDatabase {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
  }

  async query<Row extends Record<string, unknown>>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<SqlQueryResult<Row>> {
    const result = await this.pool.query(text, [...params]);
    return {
      rows: result.rows as unknown as readonly Row[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async transaction<T>(
    work: (transaction: SqlExecutor) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    const transaction: SqlExecutor = {
      query: async <Row extends Record<string, unknown>>(
        text: string,
        params: readonly unknown[] = [],
      ): Promise<SqlQueryResult<Row>> => {
        const result = await client.query(text, [...params]);
        return {
          rows: result.rows as unknown as readonly Row[],
          rowCount: result.rowCount ?? 0,
        };
      },
    };

    try {
      await client.query("BEGIN");
      const result = await work(transaction);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
