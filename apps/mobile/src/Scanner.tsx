import { useState } from "react";
import { Modal, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Button } from "./ui";
import { s } from "./theme";

/** Barkod / QR / DataMatrix okuyucu. Okunan değer yalnızca alanı doldurur; kayıt kullanıcı onayıyla yapılır. */
export function Scanner({ visible, onClose, onScan }: { visible: boolean; onClose: () => void; onScan: (value: string) => void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [done, setDone] = useState(false);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} onShow={() => setDone(false)}>
      <View style={[s.screen, s.pad]}>
        <Text style={s.h2}>Barkod okut</Text>
        {!permission?.granted ? (
          <View style={{ gap: 12 }}>
            <Text style={s.muted}>Barkod okumak için kamera izni gerekiyor.</Text>
            <Button title="Kamera iznini ver" primary onPress={requestPermission} />
          </View>
        ) : (
          <CameraView
            style={{ flex: 1, borderRadius: 14, overflow: "hidden" }}
            barcodeScannerSettings={{ barcodeTypes: ["qr", "datamatrix", "code128", "code39", "ean13", "pdf417"] }}
            onBarcodeScanned={
              done
                ? undefined
                : ({ data }) => {
                    setDone(true);
                    onScan(data.trim());
                    onClose();
                  }
            }
          />
        )}
        <Button title="Kapat" onPress={onClose} />
      </View>
    </Modal>
  );
}
