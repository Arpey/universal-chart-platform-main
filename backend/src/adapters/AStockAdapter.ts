import { BaseAdapter } from './BaseAdapter'
export class AStockAdapter extends BaseAdapter { getKlines(): Promise<any[]> { return Promise.reject(new Error('A-share adapter is not implemented')) } getTicker(): Promise<any> { return Promise.reject(new Error('A-share adapter is not implemented')) } subscribe(): () => void { return () => {} } }
