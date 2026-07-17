import { CircleCheck, Database, HardDrive, Radio, UserRound } from 'lucide-react'
import dayjs from 'dayjs'
import { useEffect, useState } from 'react'

export function StatusBar({ displayName }: { displayName: string }) { const [now, setNow] = useState(dayjs()); useEffect(() => { const id = window.setInterval(() => setNow(dayjs()), 1000); return () => clearInterval(id) }, []); return <footer className="statusbar"><span><CircleCheck size={13}/>系统状态：<b>运行中</b></span><span><Radio size={13}/>服务连接：<b>Mock 正常</b></span><span><Database size={13}/>数据源：<b>本地模拟</b></span><span className="path"><HardDrive size={13}/>会话路径：/data/train/session_fire_20260711_001</span><span><UserRound size={13}/>当前用户：{displayName}</span><time>{now.format('YYYY-MM-DD HH:mm:ss')}</time></footer> }
