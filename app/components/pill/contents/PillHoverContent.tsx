import React from 'react'
import { motion } from 'framer-motion'
import { ItoIcon } from '../../icons/ItoIcon'
import { CONTENT_EXIT } from '../constants'

const contentAbsolute: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
}

export const PillHoverContent: React.FC = () => (
  <motion.div
    key="hover-content"
    initial={{ opacity: 0, scale: 0.9 }}
    animate={{ opacity: 1, scale: 1 }}
    exit={{ opacity: 0, scale: 0.95, transition: CONTENT_EXIT }}
    transition={{ duration: 0.15, ease: [0.4, 0, 0.2, 1] }}
    style={{ ...contentAbsolute, gap: 8, padding: '0 12px' }}
  >
    <ItoIcon
      width={16}
      height={16}
      className="text-white"
      style={{ opacity: 0.7, flexShrink: 0 }}
    />
    <span
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: 'rgba(200,205,215,0.7)',
        whiteSpace: 'nowrap',
        letterSpacing: '0.2px',
      }}
    >
      Click to dictate
    </span>
  </motion.div>
)
