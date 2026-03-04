import React from 'react'
import { motion } from 'framer-motion'
import { Square } from '@mynaui/icons-react'
import { AudioWaveform } from './AudioWaveform'
import { ItoIcon } from '../../icons/ItoIcon'
import {
  IOS_SPRING_SNAPPY,
  CONTENT_ENTER,
  CONTENT_EXIT,
  RECORDING_HEIGHT,
} from '../constants'

interface PillRecordingContentProps {
  isManualRecording: boolean
  audioLevelRef: React.MutableRefObject<number>
  appTarget: { name: string; iconBase64: string | null } | null
  contextSource: 'screen' | 'selection' | null
  screenThumbnail: string | null
  onStop: (e: React.MouseEvent) => void
}

const contentAbsolute: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

export const PillRecordingContent: React.FC<PillRecordingContentProps> = ({
  isManualRecording,
  audioLevelRef,
  appTarget,
  contextSource,
  screenThumbnail,
  onStop,
}) => (
  <motion.div
    key="recording-content"
    initial={{ opacity: 0, scale: 0.85 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.9, transition: CONTENT_EXIT }}
    transition={CONTENT_ENTER}
    style={{ ...contentAbsolute, gap: 6, padding: '0 10px' }}
  >
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        flexShrink: 0,
      }}
    >
      {appTarget?.iconBase64 ? (
        <motion.img
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={IOS_SPRING_SNAPPY}
          draggable={false}
          src={`data:image/png;base64,${appTarget.iconBase64}`}
          alt={appTarget.name}
          style={{
            width: 20,
            height: 20,
            borderRadius: 5,
            flexShrink: 0,
          }}
        />
      ) : (
        <motion.div
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={IOS_SPRING_SNAPPY}
        >
          <ItoIcon width={18} height={18} className="text-white" />
        </motion.div>
      )}

      {contextSource === 'screen' && screenThumbnail && (
        <motion.img
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={IOS_SPRING_SNAPPY}
          draggable={false}
          src={`data:image/png;base64,${screenThumbnail}`}
          alt="Screen context"
          style={{
            width: 28,
            height: 18,
            borderRadius: 3,
            objectFit: 'cover',
            border: '1px solid rgba(255,255,255,0.15)',
            flexShrink: 0,
          }}
        />
      )}

      {contextSource === 'selection' && (
        <motion.span
          initial={{ scale: 0.7, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={IOS_SPRING_SNAPPY}
          style={{ fontSize: 13 }}
          aria-label="Text selection context"
        >
          📝
        </motion.span>
      )}
    </div>

    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 0,
      }}
    >
      {isManualRecording ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <AudioWaveform
            audioLevel={0}
            audioLevelRef={audioLevelRef}
            active
            width={60}
            height={RECORDING_HEIGHT}
            strokeColor="rgba(200,205,215,0.85)"
          />
          <motion.button
            onClick={onStop}
            whileHover={{ scale: 1.1 }}
            whileTap={{ scale: 0.9 }}
            aria-label="Stop recording"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'rgba(200,205,215,0.15)',
              border: '1px solid rgba(200,205,215,0.2)',
              borderRadius: 5,
              padding: '3px',
              cursor: 'pointer',
            }}
          >
            <Square
              width={12}
              height={12}
              color="rgba(200,205,215,0.9)"
              fill="currentColor"
            />
          </motion.button>
        </div>
      ) : (
        <AudioWaveform
          audioLevel={0}
          audioLevelRef={audioLevelRef}
          active
          width={80}
          height={RECORDING_HEIGHT}
          strokeColor="rgba(200,205,215,0.85)"
        />
      )}
    </div>
  </motion.div>
)
