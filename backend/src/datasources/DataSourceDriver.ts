export abstract class DataSourceDriver { abstract connect(): Promise<void>; abstract close(): Promise<void> }
