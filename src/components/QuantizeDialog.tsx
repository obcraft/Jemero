import { useEffect, useState } from 'react'
import Modal from './Modal'
import { Row, Toggle } from './SettingsPage'
import { bridge } from '../lib/models'
import { setSettings, useSettings } from '../lib/settings'

type Support = { supported: boolean; reason: string | null }

/**
 * Asked at launch until "Don't show again": prefer 4-bit model files. The
 * switch is the same one as in Settings → Generation. Where it can't help (no
 * 4-bit model fits this Mac) the dialog still opens and says why.
 */
export default function QuantizeDialog() {
  const s = useSettings()
  const [open, setOpen] = useState(s.quantizePrompt)
  const [support, setSupport] = useState<Support | null>(null)
  const [dontAsk, setDontAsk] = useState(false)

  useEffect(() => {
    const api = bridge()
    if (!api) {
      setSupport({ supported: false, reason: 'Quantization is chosen by the Mac app; this browser build has no local models.' })
      return
    }
    api.quantization().then(setSupport, (e: Error) => setSupport({ supported: false, reason: e.message }))
  }, [])

  const close = () => {
    setOpen(false)
    if (dontAsk) setSettings({ quantizePrompt: false })
  }

  const unsupported = support !== null && !support.supported

  return (
    <Modal open={open} onClose={close} title="Quantization" subtitle="Lighter, faster models">
      <p className="note">4-bit models use about half the memory and run about twice as fast.</p>
      <Row label="Use quantized models" hint={unsupported ? 'Not supported on this Mac.' : 'Change it later in Settings.'}>
        <Toggle
          value={s.quantize && !unsupported}
          disabled={support === null || unsupported}
          onChange={(quantize) => setSettings({ quantize })}
        />
      </Row>
      {unsupported && <p className="note warn-note">{support.reason}</p>}
      <label className="check-row">
        <input type="checkbox" checked={dontAsk} onChange={(e) => setDontAsk(e.target.checked)} />
        Don’t show this again
      </label>
      <button className="btn wide-btn" onClick={close}>
        Continue
      </button>
    </Modal>
  )
}
