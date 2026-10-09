export type Player={id:string;name:string;cash:number;color:string;position:number;connected:boolean};
export type Space={id:string;name:string;kind:'property'|'start'|'event'|'tax'|'rest';price?:number;rent?:number;group?:string};
export type GameStatus='lobby'|'playing'|'finished';
export type GameState={id:string;status:GameStatus;turn:number;players:Player[];spaces:Space[];ownerBySpace:Record<string,string>;lastRoll?:[number,number]};
export type GameCommand={type:'ROLL';playerId:string}|{type:'BUY';playerId:string;spaceId:string}|{type:'END_TURN';playerId:string};
