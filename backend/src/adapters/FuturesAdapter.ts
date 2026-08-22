import { BaseAdapter } from './BaseAdapter'
export class FuturesAdapter extends BaseAdapter { getKlines(): Promise<any[]> { return Promise.reject(new Error('futures adapter is not implemented')) } getTicker(): Promise<any> { return Promise.reject(new Error('futures adapter is not implemented')) } subscribe(): () => void { return () => {} } }
