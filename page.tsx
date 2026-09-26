'use client';

import { Guard } from '@/components/Guard';
import { WalletsList } from '@/components/WalletsList';

export default function CaptainWalletsPage() {
  return (
    <Guard permission="wallets.view">
      <WalletsList owner="CAPTAIN" />
    </Guard>
  );
}
