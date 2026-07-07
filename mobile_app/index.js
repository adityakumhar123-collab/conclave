import React from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import App from './App';

function Root() {
  return (
    <SafeAreaProvider style={{ flex: 1 }}>
      <App />
    </SafeAreaProvider>
  );
}

registerRootComponent(Root);
